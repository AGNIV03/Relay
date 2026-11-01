import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'browse_cache.dart';
import 'downloads.dart';
import 'models.dart';

/// The locally persisted last session (same 'last_session' key PlayerModel
/// saves), read directly from storage. Android Auto's `recent` (resume) shelf is
/// queried at CONNECT time, so it must answer instantly and offline — the
/// documented pattern (UAMP): never inline network on connect-time nodes.
Future<({List<Track> tracks, int index})?> _savedSession() async {
  try {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString('last_session');
    if (raw == null) return null;
    final data = jsonDecode(raw) as Map<String, dynamic>;
    final tracks = (data['queue'] as List).map((e) => Track.fromJson(e)).toList();
    if (tracks.isEmpty) return null;
    var index = (data['index'] as int?) ?? 0;
    if (index < 0 || index >= tracks.length) index = 0;
    return (tracks: tracks, index: index);
  } catch (_) {
    return null;
  }
}

Timer? _autoBrowseTimer;

/// Keep nudging Android Auto to re-query the browse tree.
///
/// Android Auto caches browse results aggressively and will hold a stale (often
/// empty) `root` from a previous cold start, never re-querying on its own — the
/// symptom is a permanent "No items" home even though the app is running and
/// authed. `notifyChildrenChanged` only helps a client that is *currently
/// subscribed* (i.e. the user is viewing that node in the car), and a one-shot
/// notify at startup usually fires before the user opens the app in the car. So
/// we notify on a low-frequency perpetual timer: whenever the user is viewing
/// Relay, AA re-queries within a few seconds and the home self-heals. It's cheap
/// — AA only re-queries nodes it's actively subscribed to.
void startAndroidAutoAutoRefresh() {
  if (kIsWeb || !Platform.isAndroid) return;
  _autoBrowseTimer?.cancel();
  _autoBrowseTimer = Timer.periodic(const Duration(seconds: 10), (_) {
    notifyMediaBrowsingChanged('root');
    notifyMediaBrowsingChanged('recent');
  });
}

/// Bust Android Auto's browse cache once the app/API is ready.
///
/// Android Auto caches browse results. On a cold launch its MediaBrowserService
/// can query `root` during the isolate-startup race (before Dart attaches), get an
/// empty list, and cache it — which is why the car showed "No items" until the app
/// was opened by hand. A single notify can fire before AA has subscribed, so we
/// re-notify every browse node a few times over the first several seconds; each one
/// makes AA re-query and pick up the now-loaded library.
Future<void> refreshAndroidAutoBrowse() async {
  if (kIsWeb || !Platform.isAndroid) return;
  const nodes = [
    'root',
    'recent',
    'cat::home',
    'cat::liked',
    'cat::recent',
    'cat::most',
    'cat::songs',
    'cat::playlists',
    'cat::downloads',
  ];
  for (final delayMs in [0, 800, 2500, 6000]) {
    await Future.delayed(Duration(milliseconds: delayMs));
    for (final node in nodes) {
      await notifyMediaBrowsingChanged(node);
    }
  }
}

/// Builds the media-browser tree (Android Auto / head units) from the library
/// API and resolves a tapped item back to a playable track list.
///
/// Every live list is mirrored to [BrowseCache]. When a fetch fails or is too
/// slow (offline, server down, weak signal in the car) the cached copy is served
/// instead — else a downloaded copy of the same list — so nodes don't go empty.
/// Downloads are also browsable directly (`cat::downloads`), with no network.
///
/// Media IDs:
///   `root`                       top-level categories
///   `cat::songs|liked|recent|most|playlists|downloads`
///   `pl::PLAYLIST_ID`            a playlist's tracks
///   `dl::songs`                  every downloaded track
///   `dl::pl::PLAYLIST_ID`        a downloaded playlist (id `liked` = Liked Songs)
///   `tk::CTX::TRACK_ID`          a track within a context list
///                                 (ctx in songs,liked,recent,most,pl:ID,q:QUERY,
///                                  dl,dl:PLAYLIST_ID)
class AutoBrowse {
  final Api api;
  AutoBrowse(this.api);

  /// Offline downloads, assigned in main() once DownloadManager.init() is done.
  /// Static because PlayerModel constructs its own AutoBrowse instances.
  static DownloadManager? downloads;

  static final _cache = BrowseCache.instance;

  // Past this, a live fetch counts as failed and the offline copy is served
  // (the car is waiting on us); a late response still refreshes the cache.
  static const _liveTimeout = Duration(seconds: 8);

  static const _root = 'root';

  // Content-style hints so the car UI renders nice grids/lists.
  static const _grid = {
    'android.media.browse.CONTENT_STYLE_BROWSABLE_HINT': 2,
    'android.media.browse.CONTENT_STYLE_PLAYABLE_HINT': 1,
  };
  static const _list = {
    'android.media.browse.CONTENT_STYLE_BROWSABLE_HINT': 1,
    'android.media.browse.CONTENT_STYLE_PLAYABLE_HINT': 1,
  };

  MediaItem _cat(String id, String title, {Uri? art, Map<String, dynamic>? style}) => MediaItem(
        id: id,
        title: title,
        playable: false,
        artUri: art,
        extras: style ?? _list,
      );

  /// [local]: prefer the cover saved with a download (works offline) over the
  /// server URL. Always on for the downloads contexts.
  MediaItem _trackItem(Track t, String ctx, {bool local = false}) => MediaItem(
        id: 'tk::$ctx::${t.id}',
        title: t.title,
        artist: t.artistName,
        album: t.albumTitle.isEmpty ? null : t.albumTitle,
        duration: Duration(milliseconds: (t.duration * 1000).round()),
        artUri: _trackArt(t.id, local: local || _isDownloadsCtx(ctx)),
        playable: true,
      );

  Uri _trackArt(String trackId, {bool local = false}) {
    if (local) {
      final p = downloads?.localCoverPath(trackId);
      if (p != null) return Uri.file(p);
    }
    return Uri.parse(api.trackCoverUrl(trackId));
  }

  MediaItem _playlistItem(Playlist p, {bool live = true}) {
    // Offline the server cover can't load; use a downloaded copy's art if any.
    Uri art = Uri.parse(api.playlistCoverUrl(p.id));
    if (!live) {
      final dl = _downloadedFor('dl:${p.id}');
      if (dl.isNotEmpty) art = _trackArt(dl.first.id, local: true);
    }
    return MediaItem(id: 'pl::${p.id}', title: p.name, playable: false, artUri: art, extras: _grid);
  }

  /// The "Downloads" tile, or null when nothing is downloaded.
  MediaItem? _downloadsTile({bool local = false}) {
    final songs = _downloadedFor('dl');
    if (songs.isEmpty) return null;
    return _cat('cat::downloads', 'Downloads',
        art: _trackArt(songs.first.id, local: local), style: _grid);
  }

  /// Children for a browse node.
  Future<List<MediaItem>> getChildren(String parentId) async {
    debugPrint('[AA] getChildren("$parentId") base=${api.baseUrl} loggedIn=${api.isLoggedIn}');
    // Android Auto's "resume"/recent shelf browses a separate root id ('recent').
    // It's queried at CONNECT time, so it must answer instantly and offline:
    // serve it from the locally persisted last session (documented UAMP pattern
    // — never inline network on connect-time nodes), current track first.
    if (parentId == 'recent') {
      final saved = await _savedSession();
      if (saved != null) {
        final t = saved.tracks[saved.index];
        debugPrint('[AA] recent shelf -> local last-played (1 item)');
        return [_trackItem(t, 'recent')];
      }
      final res = await _load('recent'); // fallback: network (or its cache)
      return res.tracks.map((t) => _trackItem(t, 'recent', local: !res.live)).toList();
    }
    if (parentId == _root) {
      // Android Auto contract (developer.android.com/training/cars/media):
      // root children become the car UI's TABS — they must be BROWSABLE only,
      // and gearhead may assume AT MOST 4 (Spotify's Home/Recents/Browse/Library
      // row is exactly this). They're static (no network), so the root can never
      // be raced/errored into an empty answer.
      final items = [
        _cat('cat::home', 'Home', style: _grid),
        _cat('cat::playlists', 'Playlists', style: _grid),
        _cat('cat::songs', 'Songs'),
        _cat('cat::recent', 'Recents'),
      ];
      debugPrint('[AA] getChildren("root") -> ${items.length} tabs');
      return items;
    }
    if (parentId == 'cat::home') {
      // Spotify-style Home tab: static shortcuts first (never-empty even offline
      // or before login), then the user's playlists inline with cover art.
      // Every grid tile needs an artUri — Android Auto renders icon-less grid
      // tiles as a broken-image placeholder. Cover lookups are best-effort and
      // parallel; failures degrade to no icon, never to an empty tab. Offline,
      // Downloads (the only thing that can actually play) moves to the front.
      Uri? likedArt, mostArt;
      List<Playlist> pls = const [];
      var live = true;
      try {
        final plsF = _loadPlaylists(), likedF = _load('liked'), mostF = _load('most');
        final p = await plsF, liked = await likedF, most = await mostF;
        pls = p.playlists;
        live = p.live;
        if (liked.tracks.isNotEmpty) {
          likedArt = _trackArt(liked.tracks.first.id, local: !liked.live);
        }
        if (most.tracks.isNotEmpty) mostArt = _trackArt(most.tracks.first.id, local: !most.live);
      } catch (e) {
        debugPrint('[AA] home: content fetch failed (kept static tiles): $e');
      }
      final dl = _downloadsTile(local: !live);
      final items = <MediaItem>[
        if (!live && dl != null) dl,
        _cat('cat::liked', 'Liked Songs', art: likedArt, style: _grid),
        _cat('cat::most', 'Most Played', art: mostArt, style: _grid),
        if (live && dl != null) dl,
        for (final p in pls) _playlistItem(p, live: live),
      ];
      debugPrint('[AA] getChildren("cat::home") -> ${items.length} items (live=$live)');
      return items;
    }
    if (parentId == 'cat::playlists') {
      // Liked Songs leads the Playlists tab (like Spotify's Library), then
      // Downloads, then the user's playlists. Liked art is best-effort (first
      // liked track's cover).
      Uri? likedArt;
      List<Playlist> pls = const [];
      var live = true;
      try {
        final plsF = _loadPlaylists(), likedF = _load('liked');
        final p = await plsF, liked = await likedF;
        pls = p.playlists;
        live = p.live;
        if (liked.tracks.isNotEmpty) {
          likedArt = _trackArt(liked.tracks.first.id, local: !liked.live);
        }
      } catch (_) {}
      final dl = _downloadsTile(local: !live);
      return [
        _cat('cat::liked', 'Liked Songs', art: likedArt, style: _grid),
        ?dl,
        for (final p in pls) _playlistItem(p, live: live),
      ];
    }
    if (parentId == 'cat::downloads') {
      // Local only (never the network), so it browses fully offline: every
      // downloaded song, then each downloaded playlist.
      final songs = _downloadedFor('dl');
      if (songs.isEmpty) return const [];
      return [
        _cat('dl::songs', 'Downloaded songs',
            art: _trackArt(songs.first.id, local: true), style: _grid),
        for (final p in downloads?.offlinePlaylists ?? const <OfflinePlaylist>[])
          _cat('dl::pl::${p.id}', p.name, art: _trackArt(p.tracks.first.id, local: true), style: _grid),
      ];
    }
    if (parentId.startsWith('dl::')) {
      final ctx = parentId == 'dl::songs'
          ? 'dl'
          : parentId.startsWith('dl::pl::')
              ? 'dl:${parentId.substring('dl::pl::'.length)}'
              : null;
      if (ctx == null) return const [];
      return _downloadedFor(ctx).map((t) => _trackItem(t, ctx)).toList();
    }
    if (parentId.startsWith('cat::')) {
      final ctx = parentId.substring('cat::'.length);
      final res = await _load(ctx);
      return res.tracks.map((t) => _trackItem(t, ctx, local: !res.live)).toList();
    }
    if (parentId.startsWith('pl::')) {
      final plId = parentId.substring('pl::'.length);
      final ctx = 'pl:$plId';
      final res = await _load(ctx);
      return res.tracks.map((t) => _trackItem(t, ctx, local: !res.live)).toList();
    }
    return const [];
  }

  /// A single item (used by some clients to render the now-playing tile).
  Future<MediaItem?> getMediaItem(String mediaId) async {
    if (!mediaId.startsWith('tk::')) return null;
    final parsed = _parseTrackId(mediaId);
    if (parsed == null) return null;
    final res = await _load(parsed.ctx);
    for (final t in res.tracks) {
      if (t.id == parsed.trackId) return _trackItem(t, parsed.ctx, local: !res.live);
    }
    return null;
  }

  /// Resolve a tapped track to (list, index) so the whole context plays.
  Future<({List<Track> tracks, int index})?> resolvePlay(String mediaId) async {
    final parsed = _parseTrackId(mediaId);
    if (parsed == null) return null;
    final res = await _load(parsed.ctx);
    var tracks = res.tracks;
    // Served offline, only downloaded tracks can actually play — queue just those
    // (when there are any) so a cached-but-not-downloaded entry can't stall it.
    final dm = downloads;
    if (!res.live && dm != null) {
      final playable = tracks.where((t) => dm.isDownloaded(t.id)).toList();
      if (playable.isNotEmpty) tracks = playable;
    }
    var idx = tracks.indexWhere((t) => t.id == parsed.trackId);
    if (idx < 0) idx = 0;
    if (tracks.isEmpty) return null;
    return (tracks: tracks, index: idx);
  }

  /// Free-text voice/search ("play X") -> matching playable items. The context
  /// encodes the query so tapping a result plays the whole result list.
  Future<List<MediaItem>> searchItems(String query) async {
    final q = query.trim();
    // Empty query = "Hey Google, play some music (on Relay)" — the assistant
    // wants us to just start playing. Resume the last session if there is one,
    // else fall back to most-played. Tagged so tapping/playing loads the list.
    if (q.isEmpty) {
      final saved = await _savedSession();
      if (saved != null) {
        debugPrint('[AA] searchItems("") -> resume last session (${saved.tracks.length})');
        // 'recent' context replays the saved queue starting at the saved index.
        return [for (final t in saved.tracks) _trackItem(t, 'recent')];
      }
      final most = await _load('most');
      debugPrint('[AA] searchItems("") -> most-played (${most.tracks.length})');
      return most.tracks.map((t) => _trackItem(t, 'most', local: !most.live)).toList();
    }
    // Offline this searches downloads + the cached song list instead.
    final res = await _load('q:$q');
    debugPrint('[AA] searchItems("$q") -> ${res.tracks.length} tracks '
        '(live=${res.live} loggedIn=${api.isLoggedIn})');
    return res.tracks.map((t) => _trackItem(t, 'q:$q', local: !res.live)).toList();
  }

  ({String ctx, String trackId})? _parseTrackId(String mediaId) {
    // tk::<ctx>::<trackId>  (ctx may contain a single ':' for "pl:<id>")
    final body = mediaId.substring('tk::'.length);
    final sep = body.lastIndexOf('::');
    if (sep < 0) return null;
    return (ctx: body.substring(0, sep), trackId: body.substring(sep + 2));
  }

  static bool _isDownloadsCtx(String ctx) => ctx == 'dl' || ctx.startsWith('dl:');

  /// Cache owner for the signed-in account: `<server>|<user id>`, the id read
  /// from the access token's `sub` claim (not verified — it only partitions the
  /// cache so another account/server never sees it). Null when signed out.
  String? get _owner {
    final token = api.accessToken;
    if (token == null || api.baseUrl.isEmpty) return null;
    try {
      final parts = token.split('.');
      if (parts.length != 3) return null;
      final claims = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
      final sub = claims is Map ? claims['sub'] : null;
      return sub is String && sub.isNotEmpty ? '${api.baseUrl}|$sub' : null;
    } catch (_) {
      return null;
    }
  }

  /// Await a live fetch, bounded by [_liveTimeout]; null on failure/timeout.
  /// [onData] runs whenever the response lands — even after the timeout gave up
  /// on it — so a slow link still refreshes the cache for next time.
  Future<T?> _tryLive<T extends Object>(String what, Future<T> fetch, void Function(T)? onData) async {
    if (onData != null) fetch.then(onData).ignore();
    try {
      return await fetch.timeout(_liveTimeout);
    } catch (e) {
      debugPrint('[AA] live $what failed ($e) -> offline copy');
      return null;
    }
  }

  /// The user's playlists (live, else the cached list). `live` = fetched now.
  Future<({List<Playlist> playlists, bool live})> _loadPlaylists() async {
    final owner = _owner;
    final pls = await _tryLive('playlists', api.playlists(), owner == null
        ? null
        : (List<Playlist> v) {
            // Also forget cached contents of playlists that no longer exist.
            unawaited(_cache.retainPlaylists(v.map((p) => p.id)));
            unawaited(_cache.write('playlists', owner, [
              for (final p in v) {'id': p.id, 'name': p.name},
            ]));
          });
    if (pls != null) return (playlists: pls, live: true);
    final cached = owner == null ? null : await _cache.read('playlists', owner);
    return (
      playlists: [
        for (final j in cached ?? const <Map<String, dynamic>>[])
          if (j['id'] is String) Playlist(id: j['id'] as String, name: j['name'] as String? ?? ''),
      ],
      live: false,
    );
  }

  /// The live request behind a context, or null for an unknown one.
  Future<List<Track>>? _fetch(String ctx) {
    if (ctx == 'songs') return api.tracks();
    if (ctx == 'liked') return api.liked().then((p) => p.tracks);
    if (ctx == 'recent') return api.recentlyPlayed();
    if (ctx == 'most') return api.mostPlayed();
    if (ctx.startsWith('pl:')) return api.playlist(ctx.substring(3)).then((p) => p.tracks);
    if (ctx.startsWith('q:')) return api.tracks(q: ctx.substring(2), limit: 50);
    return null;
  }

  /// A context's tracks: live when possible (and then cached), else the offline
  /// copy. `live` = fetched from the server just now.
  Future<({List<Track> tracks, bool live})> _load(String ctx) async {
    if (_isDownloadsCtx(ctx)) return (tracks: _downloadedFor(ctx), live: true);
    final fetch = _fetch(ctx);
    if (fetch == null) return (tracks: const <Track>[], live: true);
    final owner = _owner;
    void Function(List<Track>)? store;
    if (owner != null && !ctx.startsWith('q:')) {
      store = (v) => unawaited(_cache.write(ctx, owner, [
            for (final t in v.take(BrowseCache.maxEntries)) t.toJson(),
          ]));
    }
    final tracks = await _tryLive('"$ctx"', fetch, store);
    if (tracks != null) return (tracks: tracks, live: true);
    return (tracks: await _offline(ctx, owner), live: false);
  }

  /// Offline stand-in for a failed live fetch: the cached copy, else the same
  /// list as downloaded (downloaded playlists / Liked keep their source id),
  /// else — for recents — the locally saved session. Search runs locally.
  Future<List<Track>> _offline(String ctx, String? owner) async {
    if (ctx.startsWith('q:')) return _localSearch(ctx.substring(2), owner);
    final cached = await _cachedTracks(ctx, owner);
    if (cached.isNotEmpty) return cached;
    if (ctx == 'recent') return (await _savedSession())?.tracks ?? const [];
    if (ctx == 'songs') return _downloadedFor('dl');
    if (ctx == 'liked') return _downloadedFor('dl:liked');
    if (ctx.startsWith('pl:')) return _downloadedFor('dl:${ctx.substring(3)}');
    return const [];
  }

  Future<List<Track>> _cachedTracks(String key, String? owner) async {
    if (owner == null) return const [];
    final out = <Track>[];
    for (final j in await _cache.read(key, owner) ?? const <Map<String, dynamic>>[]) {
      try {
        out.add(Track.fromJson(j));
      } catch (_) {}
    }
    return out;
  }

  /// Offline "play X": every query word must appear in title/artist/album.
  /// Downloaded tracks come first (they can actually play), then cached Songs.
  Future<List<Track>> _localSearch(String query, String? owner) async {
    final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    if (words.isEmpty) return const [];
    final pool = <String, Track>{
      for (final t in _downloadedFor('dl')) t.id: t,
    };
    for (final t in await _cachedTracks('songs', owner)) {
      pool.putIfAbsent(t.id, () => t);
    }
    bool matches(Track t) {
      final hay = '${t.title} ${t.artistName} ${t.albumTitle}'.toLowerCase();
      return words.every(hay.contains);
    }

    return pool.values.where(matches).take(50).toList();
  }

  /// Downloaded tracks for `dl` (all) or `dl:<playlist id>`; local, no network.
  List<Track> _downloadedFor(String ctx) {
    final dm = downloads;
    if (dm == null || !dm.hasDownloads) return const [];
    if (ctx == 'dl') return dm.offlineTracks;
    final id = ctx.substring('dl:'.length);
    for (final p in dm.offlinePlaylists) {
      if (p.id == id) return p.tracks;
    }
    return const [];
  }
}
