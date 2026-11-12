import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart' show ValueNotifier;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'events.dart';
import 'feature_models.dart';
import 'models.dart';

/// Thin API client for the Stream server. Holds the base URL + tokens,
/// refreshes the access token transparently on 401.
class Api {
  String baseUrl;
  String? _access;
  String? _refresh;

  Api({this.baseUrl = ''});

  static const _kBase = 'server_url';
  static const _kAccess = 'access_token';
  static const _kRefresh = 'refresh_token';
  static const _kMedia = 'media_token';
  static const _kMediaExp = 'media_token_exp';

  bool get isLoggedIn => _access != null;
  String? get accessToken => _access;

  // Media token: a long-lived (7 day), media-only JWT used as `?token=` on stream
  // and cover URLs, so those URLs never carry the full access token. Null until
  // fetched, or when the server predates media tokens (then the access token is
  // used, as before).
  String? _media;
  DateTime? _mediaExp;
  bool _mediaUnsupported = false; // server answered 404: old server, use access token
  Future<void>? _mediaFetch; // single-flight

  /// The token to put in media URLs: the media token when we have one, else the
  /// access token (older server, or before the first fetch completes).
  String? get _mediaQ => _media ?? _access;

  /// Bumps when the server refuses our refresh token (password changed, "sign
  /// out of all devices", role change, account deleted). AppState signs the user
  /// out and the player stops when this fires. A network failure never fires it.
  final sessionRevoked = ValueNotifier<int>(0);

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    baseUrl = p.getString(_kBase) ?? baseUrl;
    _access = p.getString(_kAccess);
    _refresh = p.getString(_kRefresh);
    _media = p.getString(_kMedia);
    final exp = p.getString(_kMediaExp);
    _mediaExp = exp == null ? null : DateTime.tryParse(exp);
    if (_media != null && (_mediaExp == null || _mediaExp!.isBefore(DateTime.now()))) {
      _media = null; // expired while the app was closed
      _mediaExp = null;
    }
  }

  Future<void> _persist() async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_kBase, baseUrl);
    if (_access != null) await p.setString(_kAccess, _access!);
    if (_refresh != null) await p.setString(_kRefresh, _refresh!);
  }

  Future<void> clearTokens() async {
    _access = null;
    _refresh = null;
    _media = null;
    _mediaExp = null;
    final p = await SharedPreferences.getInstance();
    await p.remove(_kAccess);
    await p.remove(_kRefresh);
    await p.remove(_kMedia);
    await p.remove(_kMediaExp);
  }

  /// Make sure a usable media token is held: fetch one when there is none, when
  /// it has less than a day left, or when [force]d (a media URL just got a 401).
  /// Concurrent callers share one request. A 404 means the server predates media
  /// tokens: media URLs then keep using the access token.
  Future<void> ensureMediaToken({bool force = false}) {
    if (_access == null || baseUrl.isEmpty) return Future.value();
    if (!force) {
      if (_mediaUnsupported) return Future.value();
      final exp = _mediaExp;
      if (_media != null &&
          exp != null &&
          exp.difference(DateTime.now()) > const Duration(days: 1)) {
        return Future.value();
      }
    }
    return _mediaFetch ??= _fetchMediaToken().whenComplete(() => _mediaFetch = null);
  }

  Future<void> _fetchMediaToken() async {
    try {
      final j = await _send('POST', '/api/auth/media-token');
      if (j is Map && j['token'] is String) {
        _media = j['token'] as String;
        _mediaExp = DateTime.tryParse('${j['expiresAt']}')?.toLocal() ??
            DateTime.now().add(const Duration(days: 6));
        _mediaUnsupported = false;
        final p = await SharedPreferences.getInstance();
        await p.setString(_kMedia, _media!);
        await p.setString(_kMediaExp, _mediaExp!.toUtc().toIso8601String());
      }
    } on ApiException catch (e) {
      if (e.status == 404) {
        _mediaUnsupported = true;
        _media = null;
        _mediaExp = null;
      }
    } catch (_) {
      // Offline / transient: keep whatever we had and retry on the next call.
    }
  }

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_access != null) 'Authorization': 'Bearer $_access',
      };

  /// Normalize a user-entered server URL: trim, drop trailing slash, add a scheme
  /// if missing, and upgrade http→https for public hosts. Most hosts (Cloudflare,
  /// etc.) 301-redirect http→https, and that redirect DROPS the POST body so login
  /// silently fails — so we send https directly. Plain http is preserved for
  /// localhost / LAN addresses where it's the legitimate self-host case.
  static String normalizeServerUrl(String input) {
    var u = input.trim().replaceAll(RegExp(r'/+$'), '');
    if (u.isEmpty) return u;
    // Scheme is case-insensitive ("HTTP://x"): normalize it before checking.
    final scheme = RegExp(r'^(https?)://', caseSensitive: false).firstMatch(u);
    if (scheme != null) {
      u = '${scheme.group(1)!.toLowerCase()}://${u.substring(scheme.end)}';
    } else {
      u = 'https://$u';
    }
    // Host: a bracketed IPv6 literal ("[::1]") or up to the first ':' / '/'.
    final m = RegExp(r'^http://(\[[^\]]*\]|[^/:]+)').firstMatch(u);
    if (m != null) {
      final host = m.group(1)!.toLowerCase();
      final isLocal = host == 'localhost' ||
          host == '[::1]' ||
          host.startsWith('[fe80:') ||
          host.startsWith('[fd') ||
          host.endsWith('.local') ||
          RegExp(r'^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)').hasMatch(host);
      if (!isLocal) u = u.replaceFirst('http://', 'https://');
    }
    return u;
  }

  // ---- Auth ----
  Future<AppUser> login(String url, String username, String password) async {
    baseUrl = normalizeServerUrl(url);
    final res = await http.post(
      _uri('/api/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'username': username, 'password': password}),
    );
    if (res.statusCode != 200) {
      throw ApiException(_errorMessage(res));
    }
    final body = jsonDecode(res.body);
    _access = body['accessToken'];
    _refresh = body['refreshToken'];
    _media = null; // a new session: never reuse another login's media token
    _mediaExp = null;
    await _persist();
    unawaited(ensureMediaToken(force: true));
    return AppUser.fromJson(body['user']);
  }

  // Single-flight refresh. Refresh tokens rotate (each one is single-use and
  // reusing one revokes the whole family), so concurrent 401s must share ONE
  // refresh call instead of racing several with the same token.
  Future<bool>? _refreshing;

  Future<bool> _tryRefresh() => _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);

  /// Refresh after a request made with [usedAccess] got a 401. If another call
  /// already rotated the pair since then, just retry with the new access token
  /// instead of spending the (new) refresh token again.
  Future<bool> _refreshAfter401(String? usedAccess) {
    if (_refreshing != null) return _refreshing!;
    if (_access != null && usedAccess != _access) return Future.value(true);
    return _tryRefresh();
  }

  Future<bool> _doRefresh() async {
    final token = _refresh;
    if (token == null) return false;
    final http.Response res;
    try {
      res = await http.post(
        _uri('/api/auth/refresh'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refreshToken': token}),
      );
    } catch (_) {
      return false; // network failure: keep the tokens, try again later
    }
    if (res.statusCode == 401) {
      // The session was revoked server-side (or this refresh token was already
      // used, which revokes its family): the tokens are dead for good.
      await clearTokens();
      sessionRevoked.value++;
      return false;
    }
    if (res.statusCode != 200) return false;
    final body = jsonDecode(res.body);
    // Always persist the rotated pair: the old refresh token is now spent.
    _access = body['accessToken'];
    _refresh = body['refreshToken'] ?? _refresh;
    await _persist();
    unawaited(ensureMediaToken());
    return true;
  }

  /// Recover from a 401 on a media URL (stream / cover / download), which carry
  /// the token in the query and so bypass the normal 401-retry interceptor:
  /// refresh the access token, then force a new media token. Returns whether a
  /// usable token is now available.
  Future<bool> ensureFreshToken() async {
    final ok = await _tryRefresh();
    await ensureMediaToken(force: true);
    return ok || _media != null;
  }

  /// Changing the password revokes every session (all devices); the server hands
  /// THIS device a fresh token pair so it stays signed in.
  Future<void> changePassword(String currentPassword, String newPassword) async {
    final body = await _send(
      'POST',
      '/api/auth/change-password',
      body: {'currentPassword': currentPassword, 'newPassword': newPassword},
    );
    if (body is Map && body['accessToken'] is String) {
      _access = body['accessToken'] as String;
      _refresh = body['refreshToken'] as String? ?? _refresh;
      await _persist();
    }
  }

  /// Revoke every token for this account, on every device (including this one).
  Future<void> logoutAll() => _send('POST', '/api/auth/logout-all');

  // ---- Invites / registration ----
  /// Whether an invite code is usable on the server at [url] (doesn't consume it).
  /// Returns null when the server can't be reached or answers unexpectedly.
  static Future<bool?> checkInvite(String url, String code) async {
    final base = normalizeServerUrl(url);
    final c = code.trim();
    if (base.isEmpty || c.isEmpty) return null;
    try {
      final res = await http
          .get(Uri.parse('$base/api/auth/invite/${Uri.encodeComponent(c)}'))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode == 404) return false;
      if (res.statusCode != 200) return null;
      return (jsonDecode(res.body) as Map)['valid'] == true;
    } catch (_) {
      return null;
    }
  }

  /// Create an account with an invite code. Same response as [login]; the new
  /// token pair is persisted exactly like a login.
  Future<AppUser> register(String url, String code, String username, String password) async {
    baseUrl = normalizeServerUrl(url);
    final res = await http.post(
      _uri('/api/auth/register'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'code': code.trim(), 'username': username, 'password': password}),
    );
    if (res.statusCode != 200 && res.statusCode != 201) {
      throw ApiException(_errorMessage(res), status: res.statusCode);
    }
    final body = jsonDecode(res.body);
    _access = body['accessToken'];
    _refresh = body['refreshToken'];
    await _persist();
    return AppUser.fromJson(body['user']);
  }

  // ---- Scrobbling accounts (ListenBrainz / Last.fm) ----
  Future<ScrobblingStatus> scrobbling() async =>
      ScrobblingStatus.fromJson((await _get('/api/scrobbling') as Map).cast<String, dynamic>());

  Future<ScrobblingStatus> connectListenBrainz(String token) async => ScrobblingStatus.fromJson(
      (await _send('POST', '/api/scrobbling/listenbrainz', body: {'token': token.trim()}) as Map)
          .cast<String, dynamic>());

  Future<ScrobblingStatus> disconnectListenBrainz() async => ScrobblingStatus.fromJson(
      (await _send('DELETE', '/api/scrobbling/listenbrainz') as Map).cast<String, dynamic>());

  /// Begin Last.fm auth: the user approves [authUrl] in a browser, then we call
  /// [completeLastfm] with [token].
  Future<({String authUrl, String token})> startLastfm() async {
    final j = await _send('POST', '/api/scrobbling/lastfm/start') as Map;
    return (authUrl: j['authUrl'] as String, token: j['token'] as String);
  }

  Future<ScrobblingStatus> completeLastfm(String token) async => ScrobblingStatus.fromJson(
      (await _send('POST', '/api/scrobbling/lastfm/complete', body: {'token': token}) as Map)
          .cast<String, dynamic>());

  Future<ScrobblingStatus> disconnectLastfm() async => ScrobblingStatus.fromJson(
      (await _send('DELETE', '/api/scrobbling/lastfm') as Map).cast<String, dynamic>());

  // ---- Grouped search ----
  /// Songs / artists / albums / playlists matching [q].
  Future<SearchResults> search(String q) async {
    final t = q.trim();
    if (t.isEmpty) return SearchResults.empty;
    final j = await _get('/api/search?q=${Uri.encodeQueryComponent(t)}');
    return j is Map ? SearchResults.fromJson(j.cast<String, dynamic>()) : SearchResults.empty;
  }

  // ---- Privacy ----
  Future<({bool shareActivity, bool allowListenAlong})> privacy() async =>
      _privacyFrom(await _get('/api/social/privacy'));

  Future<({bool shareActivity, bool allowListenAlong})> setPrivacy(
          {bool? shareActivity, bool? allowListenAlong}) async =>
      _privacyFrom(await _send('PATCH', '/api/social/privacy', body: {
        'shareActivity': ?shareActivity,
        'allowListenAlong': ?allowListenAlong,
      }));

  ({bool shareActivity, bool allowListenAlong}) _privacyFrom(dynamic j) => (
        shareActivity: (j is Map ? j['shareActivity'] as bool? : null) ?? true,
        allowListenAlong: (j is Map ? j['allowListenAlong'] as bool? : null) ?? true,
      );

  // ---- Clock sync (listen-along / Chorus) ----
  // Offset of the server clock from ours (serverMs - localMs), estimated
  // NTP-style from quick pings to /api/social/time. Null until measured (or on
  // an older server without that endpoint) — callers then fall back to the
  // server-timestamp-only behaviour.
  int? _clockOffsetMs;
  int _clockSyncedAt = 0;

  int? get clockOffsetMs => _clockOffsetMs;

  /// Best estimate of the server's clock right now, or null if not yet synced.
  int? get serverNowEstimate =>
      _clockOffsetMs == null ? null : DateTime.now().millisecondsSinceEpoch + _clockOffsetMs!;

  /// Measure the clock offset: a few pings, keeping the one with the smallest
  /// round trip (least queueing noise); offset = serverNow - midpoint(send, receive).
  /// Cheap and cached for 5 minutes unless [force].
  Future<void> syncClock({bool force = false}) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    if (!force && _clockOffsetMs != null && now - _clockSyncedAt < 5 * 60 * 1000) return;
    int? bestRtt;
    int? bestOffset;
    for (var i = 0; i < 4; i++) {
      try {
        final t0 = DateTime.now().millisecondsSinceEpoch;
        final res = await http
            .get(_uri('/api/social/time'), headers: _headers)
            .timeout(const Duration(seconds: 4));
        final t3 = DateTime.now().millisecondsSinceEpoch;
        if (res.statusCode != 200) return; // older server: no time endpoint
        final serverNow = ((jsonDecode(res.body) as Map)['serverNow'] as num).toInt();
        final rtt = t3 - t0;
        if (bestRtt == null || rtt < bestRtt) {
          bestRtt = rtt;
          bestOffset = serverNow - (t0 + t3) ~/ 2;
        }
      } catch (_) {
        return;
      }
    }
    if (bestOffset != null) {
      _clockOffsetMs = bestOffset;
      _clockSyncedAt = DateTime.now().millisecondsSinceEpoch;
    }
  }

  /// Whether the server is reachable. Any non-5xx response (even 401) counts as
  /// online. A network error / timeout means offline, and so does a 5xx: while
  /// the server restarts, Cloudflare still answers the tunnel with a 502/530 error
  /// page, which must not be mistaken for a live server. Used to decide whether to
  /// enter offline mode at startup.
  Future<bool> isOnline() async {
    if (baseUrl.isEmpty) return false; // no server configured yet
    try {
      final res = await http.get(_uri('/api/health')).timeout(const Duration(seconds: 5));
      return res.statusCode > 0 && res.statusCode < 500;
    } catch (_) {
      return false;
    }
  }

  Future<AppUser?> me() async {
    try {
      final body = await _get('/api/auth/me');
      return AppUser.fromJson(body);
    } catch (_) {
      return null;
    }
  }

  // ---- Generic request helpers (with one refresh retry) ----
  Future<dynamic> _get(String path, {bool retry = true}) async {
    final used = _access;
    final res = await http.get(_uri(path), headers: _headers);
    if (res.statusCode == 401 && retry && await _refreshAfter401(used)) {
      return _get(path, retry: false);
    }
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res), status: res.statusCode);
    return res.body.isEmpty ? null : jsonDecode(res.body);
  }

  Future<dynamic> _send(String method, String path, {Object? body, bool retry = true}) async {
    final used = _access;
    final req = http.Request(method, _uri(path));
    req.headers.addAll(_headers);
    if (body != null) req.body = jsonEncode(body);
    final streamed = await http.Client().send(req);
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode == 401 && retry && await _refreshAfter401(used)) {
      return _send(method, path, body: body, retry: false);
    }
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res), status: res.statusCode);
    return res.body.isEmpty ? null : jsonDecode(res.body);
  }

  String _errorMessage(http.Response res) {
    try {
      return jsonDecode(res.body)['error'] ?? 'Error ${res.statusCode}';
    } catch (_) {
      return 'Error ${res.statusCode}';
    }
  }

  // ---- Library ----
  Future<List<Album>> recentAlbums() async =>
      (await _get('/api/library/albums?recent=1') as List).map((e) => Album.fromJson(e)).toList();

  Future<List<Album>> albums() async =>
      (await _get('/api/library/albums') as List).map((e) => Album.fromJson(e)).toList();

  Future<Album> album(String id) async => Album.fromJson(await _get('/api/library/albums/$id'));

  Future<List<Artist>> artists() async =>
      (await _get('/api/library/artists') as List).map((e) => Artist.fromJson(e)).toList();

  Future<Artist> artist(String id) async => Artist.fromJson(await _get('/api/library/artists/$id'));

  Future<List<Album>> artistAlbums(String id) async {
    final j = await _get('/api/library/artists/$id');
    return (j['albums'] as List?)?.map((e) => Album.fromJson(e)).toList() ?? [];
  }

  // ---- Songs (flat list + search) ----
  Future<List<Track>> tracks({String? q, int limit = 500}) async {
    final params = <String, String>{'limit': '$limit'};
    if (q != null && q.trim().isNotEmpty) params['q'] = q.trim();
    final qs = Uri(queryParameters: params).query;
    final j = await _get('/api/library/tracks?$qs');
    return (j['tracks'] as List).map((e) => Track.fromJson(e)).toList();
  }

  /// Hydrate specific tracks by id, preserving order (Chorus host resolving a
  /// member-proposed queue).
  Future<List<Track>> tracksByIds(List<String> ids) async {
    if (ids.isEmpty) return [];
    final j = await _get('/api/library/tracks/by-ids?ids=${ids.join(',')}');
    return (j['tracks'] as List).map((e) => Track.fromJson(e)).toList();
  }

  /// Permanently delete a track (file + DB). Admin or the uploader only.
  Future<void> deleteTrack(String trackId) => _send('DELETE', '/api/library/tracks/$trackId');

  /// Delete many tracks at once. Returns {deleted, forbidden} (forbidden = tracks
  /// the caller wasn't allowed to delete and that were skipped).
  Future<Map<String, int>> bulkDeleteTracks(List<String> ids) async {
    final j = await _send('POST', '/api/library/tracks/bulk-delete', body: {'ids': ids});
    return {
      'deleted': (j?['deleted'] ?? 0) as int,
      'forbidden': (j?['forbidden'] ?? 0) as int,
    };
  }

  // ---- Library scan (admin) ----
  /// Trigger a server-side rescan of the music folder (picks up new/removed files).
  Future<void> triggerScan() => _send('POST', '/api/admin/scan');

  /// Whether a scan is currently running.
  Future<bool> scanRunning() async {
    final j = await _get('/api/admin/scan');
    return (j is Map && j['scanning'] == true);
  }

  // ---- Playback history / personal stats ----
  /// A finished play (>= 50% or >= 4 min of a track >= 30 s), sent once per play.
  /// [startedAt] = when this play began. Forwarded to ListenBrainz / Last.fm.
  Future<void> scrobbleComplete(String trackId, DateTime startedAt) => _send(
        'POST',
        '/api/library/scrobble/complete',
        body: {'trackId': trackId, 'startedAt': startedAt.toUtc().toIso8601String()},
      );

  /// Autoplay / radio: tracks similar to [seed], never any of [exclude].
  Future<List<Track>> radio(String seed, {List<String> exclude = const [], int limit = 20}) async {
    final qs = Uri(queryParameters: {
      'seed': seed,
      if (exclude.isNotEmpty) 'exclude': exclude.join(','),
      'limit': '$limit',
    }).query;
    return (await _get('/api/library/radio?$qs') as List)
        .map((e) => Track.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> scrobble(String trackId, {String? playlistId}) => _send(
        'POST',
        '/api/library/scrobble',
        body: {'trackId': trackId, if (playlistId != null) 'playlistId': playlistId},
      );

  Future<List<Track>> recentlyPlayed() async =>
      (await _get('/api/library/recently-played') as List).map((e) => Track.fromJson(e)).toList();

  /// Grouped Recently Played: a mix of tracks and playlists (a playlist play
  /// collapses into the playlist instead of its individual songs).
  Future<List<RecentItem>> recentlyPlayedGrouped() async =>
      (await _get('/api/library/recently-played?grouped=1') as List)
          .map((e) => RecentItem.fromJson(e as Map<String, dynamic>))
          .toList();

  /// Public "curated" playlists (any owner) for the Home section.
  Future<List<PlaylistRef>> curatedPlaylists() async =>
      (await _get('/api/playlists/public') as List)
          .map((e) => PlaylistRef.fromJson(e as Map<String, dynamic>))
          .toList();

  /// Toggle a playlist public/private (owner only).
  Future<void> setPlaylistPublic(String id, bool isPublic) async {
    await _send('PATCH', '/api/playlists/$id', body: {'isPublic': isPublic});
    notifyPlaylistsChanged();
  }

  Future<List<Track>> mostPlayed() async =>
      (await _get('/api/library/most-played') as List).map((e) => Track.fromJson(e)).toList();

  Future<WrappedStats> statsMe() async => WrappedStats.fromJson(await _get('/api/library/stats/me'));

  /// Year-scoped "Rewind" stats. Defaults to the current year server-side.
  Future<RewindStats> rewind(int year) async =>
      RewindStats.fromJson(await _get('/api/library/stats/wrapped?year=$year'));

  // ---- Lyrics ----
  Future<Lyrics> lyrics(String trackId) async =>
      Lyrics.fromJson(await _get('/api/library/tracks/$trackId/lyrics'));

  /// English machine-translation of a track's lyrics (null if already English).
  Future<({String? lang, String? translated})> lyricsTranslation(String trackId) async {
    final j = await _get('/api/library/tracks/$trackId/lyrics/translation');
    return (lang: j['lang'] as String?, translated: j['translated'] as String?);
  }

  // ---- Uploads ----
  /// Upload local audio files (multipart). Server restricts to MP3/FLAC and
  /// validates contents. Returns {added, failed, addedNames, failedNames, ...}.
  /// [onProgress] reports (bytesSent, totalBytes) as the body streams out.
  Future<Map<String, dynamic>> uploadTracks(List<String> paths,
      {bool retry = true, void Function(int sent, int total)? onProgress}) async {
    final req = http.MultipartRequest('POST', _uri('/api/library/upload'));
    if (_access != null) req.headers['Authorization'] = 'Bearer $_access';
    for (final p in paths) {
      req.files.add(await http.MultipartFile.fromPath('files', p));
    }
    final client = http.Client();
    final http.Response res;
    try {
      final streamed = await client.send(_CountingRequest.multipart(req, onProgress));
      res = await http.Response.fromStream(streamed);
    } finally {
      client.close();
    }
    if (res.statusCode == 401 && retry && await _tryRefresh()) {
      return uploadTracks(paths, retry: false, onProgress: onProgress);
    }
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res));
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Size at/above which a file is uploaded in chunks (Cloudflare caps a single
  /// request body at ~100MB).
  static const chunkThreshold = 90 * 1024 * 1024;

  /// Upload one large file in 64MB chunks (each under the CDN cap), then finalize.
  /// [onProgress] reports (bytesSent, fileSize) across all chunks.
  Future<Map<String, dynamic>> uploadTrackChunked(String filePath,
      {bool retry = true, void Function(int sent, int total)? onProgress}) async {
    const chunkSize = 64 * 1024 * 1024;
    final file = File(filePath);
    final size = await file.length();
    final total = size <= 0 ? 1 : (size / chunkSize).ceil();
    final uploadId =
        '${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}${filePath.hashCode.toUnsigned(31).toRadixString(36)}';
    final raf = await file.open();
    try {
      for (var i = 0; i < total; i++) {
        final bytes = await raf.read(chunkSize);
        if (bytes.isEmpty) break;
        final before = i * chunkSize;
        final client = http.Client();
        final http.Response res;
        try {
          final streamed = await client.send(_CountingRequest.bytes(
            'POST',
            _uri('/api/library/upload/chunk?uploadId=$uploadId&index=$i'),
            bytes,
            {
              'Content-Type': 'application/octet-stream',
              if (_access != null) 'Authorization': 'Bearer $_access',
            },
            onProgress == null ? null : (s, _) => onProgress(before + s, size),
          ));
          res = await http.Response.fromStream(streamed);
        } finally {
          client.close();
        }
        if (res.statusCode == 401 && retry && await _tryRefresh()) {
          await raf.close();
          return uploadTrackChunked(filePath, retry: false, onProgress: onProgress);
        }
        if (res.statusCode >= 400) throw ApiException(_errorMessage(res));
      }
    } finally {
      await raf.close();
    }
    final fin = await http.post(
      _uri('/api/library/upload/finalize'),
      headers: {
        'Content-Type': 'application/json',
        if (_access != null) 'Authorization': 'Bearer $_access',
      },
      body: jsonEncode({'uploadId': uploadId, 'filename': file.uri.pathSegments.last}),
    );
    if (fin.statusCode >= 400) throw ApiException(_errorMessage(fin));
    return jsonDecode(fin.body) as Map<String, dynamic>;
  }

  /// Upload any number of files reliably. Small files are grouped into size-capped
  /// multipart batches so a single request never exceeds the CDN's ~100MB body cap
  /// (uploading several lossless tracks in one request used to fail); large files
  /// are chunked individually. Returns aggregated {added, failed, duplicates,
  /// rejected, results} where `results` maps each path to its [UploadFileResult].
  ///
  /// [onFileProgress] reports (path, bytesSent, fileSize) per file (within a
  /// multipart batch the bytes are apportioned in file order); [onFileDone]
  /// fires once per file with its final outcome.
  Future<Map<String, dynamic>> uploadManyTracks(
    List<String> paths, {
    void Function(String path, int sent, int total)? onFileProgress,
    void Function(String path, UploadFileResult result)? onFileDone,
  }) async {
    const batchBytes = 80 * 1024 * 1024;
    const batchCount = 25;
    var added = 0, failed = 0, duplicates = 0;
    // Files the server refused as broken (no playable audio etc.): {name, reason}.
    final rejected = <({String name, String reason})>[];
    final results = <String, UploadFileResult>{};
    void merge(Map<String, dynamic> r) {
      added += (r['added'] ?? 0) as int;
      failed += (r['failed'] ?? 0) as int;
      duplicates += (r['duplicates'] ?? 0) as int;
      for (final e in (r['rejected'] as List?) ?? const []) {
        if (e is Map) {
          rejected.add((name: '${e['name'] ?? ''}', reason: '${e['reason'] ?? 'Rejected'}'));
        }
      }
    }

    void done(String path, UploadFileResult r) {
      results[path] = r;
      onFileDone?.call(path, r);
    }

    // Work out each file's outcome from a response's name lists. Names are
    // consumed as they're matched, so two files with the same name both resolve.
    void resolve(List<String> batch, Map<String, dynamic> r) {
      List<String> names(String k) => [for (final n in (r[k] as List?) ?? const []) '$n'];
      final addedN = names('addedNames');
      final dupN = names('duplicateNames');
      final failedN = names('failedNames');
      final rej = [
        for (final e in (r['rejected'] as List?) ?? const [])
          if (e is Map) (name: '${e['name'] ?? ''}', reason: '${e['reason'] ?? 'Rejected'}'),
      ];
      final noNames = addedN.isEmpty && dupN.isEmpty && failedN.isEmpty && rej.isEmpty;
      for (final p in batch) {
        final n = _baseName(p);
        final ri = rej.indexWhere((e) => e.name == n);
        if (ri >= 0) {
          done(p, UploadFileResult(n, UploadStatus.rejected, rej.removeAt(ri).reason));
          failedN.remove(n);
        } else if (addedN.remove(n)) {
          done(p, UploadFileResult(n, UploadStatus.added));
        } else if (dupN.remove(n)) {
          done(p, UploadFileResult(n, UploadStatus.duplicate));
        } else if (failedN.remove(n)) {
          done(p, UploadFileResult(n, UploadStatus.failed));
        } else if (noNames && batch.length == 1) {
          // A response without name lists (older server): go by the counts.
          final s = ((r['added'] ?? 0) as int) > 0
              ? UploadStatus.added
              : ((r['duplicates'] ?? 0) as int) > 0
                  ? UploadStatus.duplicate
                  : UploadStatus.failed;
          done(p, UploadFileResult(n, s));
        } else {
          done(p, UploadFileResult(n, UploadStatus.failed));
        }
      }
    }

    final sizes = <String, int>{};
    for (final p in paths) {
      try {
        sizes[p] = await File(p).length();
      } catch (_) {
        sizes[p] = 0;
      }
    }
    final small = paths.where((p) => sizes[p]! < chunkThreshold).toList();
    final large = paths.where((p) => sizes[p]! >= chunkThreshold).toList();

    // Greedy size-capped batches of small files.
    final batches = <List<String>>[];
    var cur = <String>[];
    var curSize = 0;
    for (final p in small) {
      if (cur.isNotEmpty && (curSize + sizes[p]! > batchBytes || cur.length >= batchCount)) {
        batches.add(cur);
        cur = [];
        curSize = 0;
      }
      cur.add(p);
      curSize += sizes[p]!;
    }
    if (cur.isNotEmpty) batches.add(cur);

    for (final batch in batches) {
      final fileBytes = batch.fold<int>(0, (a, p) => a + sizes[p]!);
      void progress(int sent, int total) {
        if (onFileProgress == null || total <= 0) return;
        // The multipart body is the files in order plus a little framing: scale
        // the bytes sent to file bytes and hand each file its share.
        final scaled = sent * fileBytes / total;
        var start = 0;
        for (final p in batch) {
          final sz = sizes[p]!;
          onFileProgress(p, (scaled - start).clamp(0, sz).round(), sz);
          start += sz;
        }
      }

      try {
        final r = await uploadTracks(batch, onProgress: progress);
        merge(r);
        resolve(batch, r);
      } catch (e) {
        failed += batch.length;
        for (final p in batch) {
          done(p, UploadFileResult(_baseName(p), UploadStatus.failed, '$e'));
        }
      }
    }
    for (final p in large) {
      try {
        final r = await uploadTrackChunked(p,
            onProgress: onFileProgress == null ? null : (s, t) => onFileProgress(p, s, t));
        merge(r);
        resolve([p], r);
      } catch (e) {
        failed += 1;
        done(p, UploadFileResult(_baseName(p), UploadStatus.failed, '$e'));
      }
    }
    return {
      'added': added,
      'failed': failed,
      'duplicates': duplicates,
      'rejected': rejected,
      'results': results,
    };
  }

  static String _baseName(String path) => path.split(RegExp(r'[\\/]')).last;

  // ---- Likes / Liked Songs ----
  Future<List<String>> likedIds() async =>
      (await _get('/api/library/liked/ids') as List).cast<String>();
  Future<Playlist> liked() async => Playlist.fromJson(await _get('/api/library/liked'));
  Future<void> like(String trackId) =>
      _send('POST', '/api/library/like', body: {'trackId': trackId});
  Future<void> unlike(String trackId) => _send('DELETE', '/api/library/like/$trackId');

  // ---- Playlists ----
  Future<List<Playlist>> playlists() async =>
      (await _get('/api/playlists') as List).map((e) => Playlist.fromJson(e)).toList();
  Future<Playlist> playlist(String id) async => Playlist.fromJson(await _get('/api/playlists/$id'));
  /// Create a playlist and return its id (so callers can add tracks straight away).
  Future<String> createPlaylist(String name) async {
    final j = await _send('POST', '/api/playlists', body: {'name': name});
    notifyPlaylistsChanged();
    return (j as Map<String, dynamic>)['id'] as String;
  }

  Future<void> renamePlaylist(String id, String name) async {
    await _send('PATCH', '/api/playlists/$id', body: {'name': name});
    notifyPlaylistsChanged();
  }

  Future<void> deletePlaylist(String id) async {
    await _send('DELETE', '/api/playlists/$id');
    notifyPlaylistsChanged();
  }

  // ---- Playlist collaborators ----
  /// {owner: UserRef, collaborators: [UserRef]}
  Future<({UserRef owner, List<UserRef> collaborators})> playlistCollaborators(String id) async {
    final j = await _get('/api/playlists/$id/collaborators');
    return (
      owner: UserRef.fromJson(j['owner']),
      collaborators: (j['collaborators'] as List).map((e) => UserRef.fromJson(e)).toList(),
    );
  }

  Future<void> addCollaborator(String playlistId, String userId) =>
      _send('POST', '/api/playlists/$playlistId/collaborators', body: {'userId': userId});
  Future<void> removeCollaborator(String playlistId, String userId) =>
      _send('DELETE', '/api/playlists/$playlistId/collaborators/$userId');

  // ---- Public user profile (friend popup) ----
  Future<UserProfile> userProfile(String userId) async =>
      UserProfile.fromJson(await _get('/api/social/users/$userId'));
  Future<void> addToPlaylist(String playlistId, String trackId) =>
      _send('POST', '/api/playlists/$playlistId/tracks', body: {'trackId': trackId});
  /// Add many tracks to a playlist at once (already-present tracks are skipped).
  /// Returns the number actually added.
  Future<int> addManyToPlaylist(String playlistId, List<String> trackIds) async {
    final j = await _send('POST', '/api/playlists/$playlistId/tracks/bulk',
        body: {'trackIds': trackIds});
    return (j?['added'] ?? 0) as int;
  }
  Future<void> removeFromPlaylist(String playlistId, String trackId) =>
      _send('DELETE', '/api/playlists/$playlistId/tracks/$trackId');

  /// Save a playlist's full new track order (owner or collaborator).
  Future<void> reorderPlaylist(String playlistId, List<String> trackIds) =>
      _send('PATCH', '/api/playlists/$playlistId/tracks/order', body: {'trackIds': trackIds});

  /// Remove many tracks from a playlist at once. Returns how many were removed.
  Future<int> removeManyFromPlaylist(String playlistId, List<String> trackIds) async {
    final j = await _send('POST', '/api/playlists/$playlistId/tracks/remove',
        body: {'trackIds': trackIds});
    return (j is Map ? j['removed'] as int? : null) ?? trackIds.length;
  }

  /// Build a playlist from an M3U file, pasted "Artist - Title" lines, or a
  /// Spotify playlist URL. [source] is 'm3u' | 'text' | 'spotify'.
  Future<ImportResult> importPlaylist(
      {required String name, required String source, String? content, String? url}) async {
    final j = await _send('POST', '/api/playlists/import', body: {
      'name': name,
      'source': source,
      'content': ?content,
      'url': ?url,
    });
    notifyPlaylistsChanged();
    return ImportResult.fromJson((j as Map).cast<String, dynamic>());
  }

  // ---- Playlist cover art ----
  /// `v` busts the image cache after a regenerate/upload.
  String playlistCoverUrl(String id, [int v = 0]) =>
      '$baseUrl/api/playlists/$id/cover?token=$_mediaQ&v=$v';

  Future<void> regeneratePlaylistCover(String id) =>
      _send('POST', '/api/playlists/$id/cover/regenerate');

  Future<void> uploadPlaylistCover(String id, String filePath, {bool retry = true}) async {
    final req = http.MultipartRequest('POST', _uri('/api/playlists/$id/cover'));
    if (_access != null) req.headers['Authorization'] = 'Bearer $_access';
    req.files.add(await http.MultipartFile.fromPath('cover', filePath));
    final streamed = await req.send();
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode == 401 && retry && await _tryRefresh()) {
      return uploadPlaylistCover(id, filePath, retry: false);
    }
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res));
  }

  /// Upload a cover from raw bytes. More reliable than a file path on Android,
  /// where the picked image is often only available as bytes.
  Future<void> uploadPlaylistCoverBytes(String id, List<int> bytes, String filename,
      {bool retry = true}) async {
    final req = http.MultipartRequest('POST', _uri('/api/playlists/$id/cover'));
    if (_access != null) req.headers['Authorization'] = 'Bearer $_access';
    req.files.add(http.MultipartFile.fromBytes('cover', bytes, filename: filename));
    final streamed = await req.send();
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode == 401 && retry && await _tryRefresh()) {
      return uploadPlaylistCoverBytes(id, bytes, filename, retry: false);
    }
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res));
  }

  // ---- Social / friends ----
  /// [atServerMs] = our estimate of the SERVER clock at the moment [positionMs]
  /// was read, so followers can extrapolate from when the position was true
  /// rather than from when the post happened to arrive.
  Future<void> postActivity(
          {String? trackId,
          required int positionMs,
          required bool playing,
          String? listeningTo,
          int? atServerMs}) =>
      _send('POST', '/api/social/activity', body: {
        'trackId': trackId,
        'positionMs': positionMs,
        'playing': playing,
        'listeningTo': listeningTo,
        'atServerMs': ?atServerMs,
      });

  Future<List<Friend>> friends() async =>
      (await _get('/api/social/friends') as List).map((e) => Friend.fromJson(e)).toList();

  Future<HostActivity> userActivity(String userId) async =>
      HostActivity.fromJson(await _get('/api/social/activity/$userId'));

  /// Long-poll a host's activity: resolves as soon as their playback changes past
  /// [since] (or after the server's ~25s hold). Used by listen-along for tight sync.
  Future<HostActivity> userActivityPoll(String userId, int since) async {
    final res = await http
        .get(_uri('/api/social/activity/$userId/poll?since=$since'), headers: _headers)
        .timeout(const Duration(seconds: 35));
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res), status: res.statusCode);
    return HostActivity.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  }

  // ---- Chorus (collaborative synced listening) ----
  /// The chorus the current user is in, or null.
  Future<ChorusState?> chorus() async {
    final j = await _get('/api/chorus');
    return j == null ? null : ChorusState.fromJson(j as Map<String, dynamic>);
  }

  /// Long-poll the chorus: resolves as soon as it changes past [since] (or after
  /// the server's ~25s hold). Host polls also receive queued member commands.
  /// Returns null if no longer in a chorus.
  Future<ChorusState?> chorusPoll(int since) async {
    final used = _access;
    final res = await http
        .get(_uri('/api/chorus/poll?since=$since'), headers: _headers)
        .timeout(const Duration(seconds: 35));
    if (res.statusCode == 401 && await _refreshAfter401(used)) {
      final r2 = await http
          .get(_uri('/api/chorus/poll?since=$since'), headers: _headers)
          .timeout(const Duration(seconds: 35));
      if (r2.statusCode >= 400) throw ApiException(_errorMessage(r2));
      final b2 = r2.body.isEmpty ? null : jsonDecode(r2.body);
      return b2 == null ? null : ChorusState.fromJson(b2 as Map<String, dynamic>);
    }
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res));
    final b = res.body.isEmpty ? null : jsonDecode(res.body);
    return b == null ? null : ChorusState.fromJson(b as Map<String, dynamic>);
  }

  /// A member asks the host to change playback (song / queue / play-pause / seek).
  Future<void> sendChorusCommand({
    List<String>? queue,
    int? index,
    int? positionMs,
    bool? playing,
  }) =>
      _send('POST', '/api/chorus/command', body: {
        if (queue != null) 'queue': queue,
        if (index != null) 'index': index,
        if (positionMs != null) 'positionMs': positionMs,
        if (playing != null) 'playing': playing,
      });

  Future<ChorusState> startChorus(
    String mode,
    List<String> queue,
    int index,
    int positionMs,
    bool playing,
  ) async =>
      ChorusState.fromJson(await _send('POST', '/api/chorus/start', body: {
        'mode': mode,
        'queue': queue,
        'index': index,
        'positionMs': positionMs,
        'playing': playing,
      }) as Map<String, dynamic>);

  Future<void> stopChorus() => _send('POST', '/api/chorus/stop');
  Future<void> leaveChorus() => _send('POST', '/api/chorus/leave');
  Future<void> setChorusMode(String mode) =>
      _send('POST', '/api/chorus/mode', body: {'mode': mode});

  /// Returns 'joined' or 'requested'.
  Future<String> joinChorus(String hostId) async {
    final j = await _send('POST', '/api/chorus/join', body: {'hostId': hostId});
    return (j is Map ? j['status'] as String? : null) ?? 'requested';
  }

  Future<void> approveChorus(String userId) =>
      _send('POST', '/api/chorus/approve', body: {'userId': userId});
  Future<void> denyChorus(String userId) =>
      _send('POST', '/api/chorus/deny', body: {'userId': userId});
  Future<void> removeFromChorus(String userId) =>
      _send('POST', '/api/chorus/remove', body: {'userId': userId});

  Future<void> postChorusState(List<String> queue, int index, int positionMs, bool playing,
          {int? atServerMs}) =>
      _send('POST', '/api/chorus/state', body: {
        'queue': queue,
        'index': index,
        'positionMs': positionMs,
        'playing': playing,
        'atServerMs': ?atServerMs,
      });

  // ---- Media URLs (token in query so the audio engine can authenticate) ----
  // Built with the media token (see [ensureMediaToken]); falls back to the
  // access token against an older server.
  String streamUrl(String trackId) => '$baseUrl/api/stream/$trackId?token=$_mediaQ';
  String albumCoverUrl(String albumId) =>
      '$baseUrl/api/stream/album/$albumId/cover?token=$_mediaQ';
  String trackCoverUrl(String trackId) => '$baseUrl/api/stream/$trackId/cover?token=$_mediaQ';

  /// A stream URL transcoded on the fly (e.g. `mp3` @ 320 kbps for a Chromecast
  /// that can't decode the source file).
  String transcodedStreamUrl(String trackId, {required String format, int bitrate = 320}) =>
      '$baseUrl/api/stream/$trackId?token=$_mediaQ&format=$format&bitrate=$bitrate';
}

class ApiException implements Exception {
  final String message;
  final int? status; // HTTP status when the server answered (e.g. 403 = not allowed)
  ApiException(this.message, {this.status});
  @override
  String toString() => message;
}

/// A request whose body streams from [_body], reporting bytes as the socket
/// consumes them (upload progress bars).
class _CountingRequest extends http.BaseRequest {
  final Stream<List<int>> _body;
  final void Function(int sent, int total)? _onProgress;

  _CountingRequest(super.method, super.url, this._body, int length, this._onProgress,
      {Map<String, String> headers = const {}}) {
    this.headers.addAll(headers);
    contentLength = length;
  }

  /// Wrap a multipart request (finalizing it sets its boundary content-type).
  factory _CountingRequest.multipart(
      http.MultipartRequest m, void Function(int sent, int total)? onProgress) {
    final body = m.finalize();
    return _CountingRequest(m.method, m.url, body, m.contentLength, onProgress,
        headers: m.headers);
  }

  /// Send [bytes] in 64KB slices so progress moves smoothly.
  factory _CountingRequest.bytes(String method, Uri url, List<int> bytes,
      Map<String, String> headers, void Function(int sent, int total)? onProgress) {
    const slice = 64 * 1024;
    Stream<List<int>> slices() async* {
      for (var i = 0; i < bytes.length; i += slice) {
        yield bytes.sublist(i, i + slice > bytes.length ? bytes.length : i + slice);
      }
    }

    return _CountingRequest(method, url, slices(), bytes.length, onProgress, headers: headers);
  }

  @override
  http.ByteStream finalize() {
    super.finalize();
    final total = contentLength ?? -1;
    var sent = 0;
    return http.ByteStream(_body.map((chunk) {
      sent += chunk.length;
      _onProgress?.call(sent, total);
      return chunk;
    }));
  }
}
