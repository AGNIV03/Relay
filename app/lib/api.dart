import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'events.dart';
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

  bool get isLoggedIn => _access != null;
  String? get accessToken => _access;

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    baseUrl = p.getString(_kBase) ?? baseUrl;
    _access = p.getString(_kAccess);
    _refresh = p.getString(_kRefresh);
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
    final p = await SharedPreferences.getInstance();
    await p.remove(_kAccess);
    await p.remove(_kRefresh);
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
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://$u';
    final m = RegExp(r'^http://([^/:]+)').firstMatch(u);
    if (m != null) {
      final host = m.group(1)!;
      final isLocal = host == 'localhost' ||
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
    await _persist();
    return AppUser.fromJson(body['user']);
  }

  Future<bool> _tryRefresh() async {
    if (_refresh == null) return false;
    final res = await http.post(
      _uri('/api/auth/refresh'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'refreshToken': _refresh}),
    );
    if (res.statusCode != 200) return false;
    final body = jsonDecode(res.body);
    _access = body['accessToken'];
    _refresh = body['refreshToken'];
    await _persist();
    return true;
  }

  /// Force a token refresh (used by media/download fetches that put the token in
  /// the URL query and so bypass the normal 401-retry interceptor). Returns
  /// whether a fresh access token is now available.
  Future<bool> ensureFreshToken() => _tryRefresh();

  Future<void> changePassword(String currentPassword, String newPassword) => _send(
        'POST',
        '/api/auth/change-password',
        body: {'currentPassword': currentPassword, 'newPassword': newPassword},
      );

  /// Whether the server is reachable. Any HTTP response (even 401) counts as
  /// online; only a network error / timeout means offline. Used to decide
  /// whether to enter offline mode at startup.
  Future<bool> isOnline() async {
    if (baseUrl.isEmpty) return false; // no server configured yet
    try {
      final res = await http.get(_uri('/api/health')).timeout(const Duration(seconds: 5));
      return res.statusCode > 0;
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
    final res = await http.get(_uri(path), headers: _headers);
    if (res.statusCode == 401 && retry && await _tryRefresh()) {
      return _get(path, retry: false);
    }
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res));
    return res.body.isEmpty ? null : jsonDecode(res.body);
  }

  Future<dynamic> _send(String method, String path, {Object? body, bool retry = true}) async {
    final req = http.Request(method, _uri(path));
    req.headers.addAll(_headers);
    if (body != null) req.body = jsonEncode(body);
    final streamed = await http.Client().send(req);
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode == 401 && retry && await _tryRefresh()) {
      return _send(method, path, body: body, retry: false);
    }
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res));
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

  // ---- Library scan (admin) ----
  /// Trigger a server-side rescan of the music folder (picks up new/removed files).
  Future<void> triggerScan() => _send('POST', '/api/admin/scan');

  /// Whether a scan is currently running.
  Future<bool> scanRunning() async {
    final j = await _get('/api/admin/scan');
    return (j is Map && j['scanning'] == true);
  }

  // ---- Playback history / personal stats ----
  Future<void> scrobble(String trackId) =>
      _send('POST', '/api/library/scrobble', body: {'trackId': trackId});

  Future<List<Track>> recentlyPlayed() async =>
      (await _get('/api/library/recently-played') as List).map((e) => Track.fromJson(e)).toList();

  Future<List<Track>> mostPlayed() async =>
      (await _get('/api/library/most-played') as List).map((e) => Track.fromJson(e)).toList();

  Future<WrappedStats> statsMe() async => WrappedStats.fromJson(await _get('/api/library/stats/me'));

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
  /// validates contents. Returns {added, failed, addedNames, failedNames}.
  Future<Map<String, dynamic>> uploadTracks(List<String> paths, {bool retry = true}) async {
    final req = http.MultipartRequest('POST', _uri('/api/library/upload'));
    if (_access != null) req.headers['Authorization'] = 'Bearer $_access';
    for (final p in paths) {
      req.files.add(await http.MultipartFile.fromPath('files', p));
    }
    final streamed = await req.send();
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode == 401 && retry && await _tryRefresh()) {
      return uploadTracks(paths, retry: false);
    }
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res));
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Size at/above which a file is uploaded in chunks (Cloudflare caps a single
  /// request body at ~100MB).
  static const chunkThreshold = 90 * 1024 * 1024;

  /// Upload one large file in 64MB chunks (each under the CDN cap), then finalize.
  Future<Map<String, dynamic>> uploadTrackChunked(String filePath, {bool retry = true}) async {
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
        final res = await http.post(
          _uri('/api/library/upload/chunk?uploadId=$uploadId&index=$i'),
          headers: {
            'Content-Type': 'application/octet-stream',
            if (_access != null) 'Authorization': 'Bearer $_access',
          },
          body: bytes,
        );
        if (res.statusCode == 401 && retry && await _tryRefresh()) {
          await raf.close();
          return uploadTrackChunked(filePath, retry: false);
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
  Future<void> createPlaylist(String name) async {
    await _send('POST', '/api/playlists', body: {'name': name});
    notifyPlaylistsChanged();
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
  Future<void> removeFromPlaylist(String playlistId, String trackId) =>
      _send('DELETE', '/api/playlists/$playlistId/tracks/$trackId');

  // ---- Playlist cover art ----
  /// `v` busts the image cache after a regenerate/upload.
  String playlistCoverUrl(String id, [int v = 0]) =>
      '$baseUrl/api/playlists/$id/cover?token=$_access&v=$v';

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

  // ---- Social / friends ----
  Future<void> postActivity({String? trackId, required int positionMs, required bool playing}) =>
      _send('POST', '/api/social/activity',
          body: {'trackId': trackId, 'positionMs': positionMs, 'playing': playing});

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
    if (res.statusCode >= 400) throw ApiException(_errorMessage(res));
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
    final res = await http
        .get(_uri('/api/chorus/poll?since=$since'), headers: _headers)
        .timeout(const Duration(seconds: 35));
    if (res.statusCode == 401 && await _tryRefresh()) {
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

  Future<void> postChorusState(List<String> queue, int index, int positionMs, bool playing) =>
      _send('POST', '/api/chorus/state', body: {
        'queue': queue,
        'index': index,
        'positionMs': positionMs,
        'playing': playing,
      });

  // ---- Media URLs (token in query so the audio engine can authenticate) ----
  String streamUrl(String trackId) => '$baseUrl/api/stream/$trackId?token=$_access';
  String albumCoverUrl(String albumId) =>
      '$baseUrl/api/stream/album/$albumId/cover?token=$_access';
  String trackCoverUrl(String trackId) => '$baseUrl/api/stream/$trackId/cover?token=$_access';
}

class ApiException implements Exception {
  final String message;
  ApiException(this.message);
  @override
  String toString() => message;
}
