import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
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
/// Media IDs:
///   `root`                       top-level categories
///   `cat::songs|liked|recent|most|playlists`
///   `pl::PLAYLIST_ID`            a playlist's tracks
///   `tk::CTX::TRACK_ID`          a track within a context list
///                                 (ctx in songs,liked,recent,most,pl:ID,q:QUERY)
class AutoBrowse {
  final Api api;
  AutoBrowse(this.api);

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

  MediaItem _trackItem(Track t, String ctx) => MediaItem(
        id: 'tk::$ctx::${t.id}',
        title: t.title,
        artist: t.artistName,
        album: t.albumTitle.isEmpty ? null : t.albumTitle,
        duration: Duration(milliseconds: (t.duration * 1000).round()),
        artUri: Uri.parse(api.trackCoverUrl(t.id)),
        playable: true,
      );

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
      final tracks = await _tracksFor('recent'); // fallback: network
      return tracks.map((t) => _trackItem(t, 'recent')).toList();
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
      // parallel; failures degrade to no icon, never to an empty tab.
      Uri? likedArt, mostArt;
      List<Playlist> pls = const [];
      try {
        final results = await Future.wait<dynamic>([
          api.playlists().catchError((_) => <Playlist>[]),
          api.liked().catchError((_) => Playlist(id: 'liked', name: 'Liked Songs')),
          api.mostPlayed().catchError((_) => <Track>[]),
        ]);
        pls = results[0] as List<Playlist>;
        final likedTracks = (results[1] as Playlist).tracks;
        if (likedTracks.isNotEmpty) {
          likedArt = Uri.parse(api.trackCoverUrl(likedTracks.first.id));
        }
        final most = results[2] as List<Track>;
        if (most.isNotEmpty) mostArt = Uri.parse(api.trackCoverUrl(most.first.id));
      } catch (e) {
        debugPrint('[AA] home: content fetch failed (kept static tiles): $e');
      }
      final items = <MediaItem>[
        _cat('cat::liked', 'Liked Songs', art: likedArt, style: _grid),
        _cat('cat::most', 'Most Played', art: mostArt, style: _grid),
        for (final p in pls)
          MediaItem(
            id: 'pl::${p.id}',
            title: p.name,
            playable: false,
            artUri: Uri.parse(api.playlistCoverUrl(p.id)),
            extras: _grid,
          ),
      ];
      debugPrint('[AA] getChildren("cat::home") -> ${items.length} items');
      return items;
    }
    if (parentId == 'cat::playlists') {
      // Liked Songs leads the Playlists tab (like Spotify's Library), then the
      // user's playlists. Liked art is best-effort (first liked track's cover).
      Uri? likedArt;
      List<Playlist> pls = const [];
      try {
        final results = await Future.wait<dynamic>([
          api.playlists().catchError((_) => <Playlist>[]),
          api.liked().catchError((_) => Playlist(id: 'liked', name: 'Liked Songs')),
        ]);
        pls = results[0] as List<Playlist>;
        final likedTracks = (results[1] as Playlist).tracks;
        if (likedTracks.isNotEmpty) {
          likedArt = Uri.parse(api.trackCoverUrl(likedTracks.first.id));
        }
      } catch (_) {}
      return [
        _cat('cat::liked', 'Liked Songs', art: likedArt, style: _grid),
        for (final p in pls)
          MediaItem(
            id: 'pl::${p.id}',
            title: p.name,
            playable: false,
            artUri: Uri.parse(api.playlistCoverUrl(p.id)),
            extras: _grid,
          ),
      ];
    }
    if (parentId.startsWith('cat::')) {
      final ctx = parentId.substring('cat::'.length);
      final tracks = await _tracksFor(ctx);
      return tracks.map((t) => _trackItem(t, ctx)).toList();
    }
    if (parentId.startsWith('pl::')) {
      final plId = parentId.substring('pl::'.length);
      final ctx = 'pl:$plId';
      final tracks = await _tracksFor(ctx);
      return tracks.map((t) => _trackItem(t, ctx)).toList();
    }
    return const [];
  }

  /// A single item (used by some clients to render the now-playing tile).
  Future<MediaItem?> getMediaItem(String mediaId) async {
    if (!mediaId.startsWith('tk::')) return null;
    final parsed = _parseTrackId(mediaId);
    if (parsed == null) return null;
    final tracks = await _tracksFor(parsed.ctx);
    for (final t in tracks) {
      if (t.id == parsed.trackId) return _trackItem(t, parsed.ctx);
    }
    return null;
  }

  /// Resolve a tapped track to (list, index) so the whole context plays.
  Future<({List<Track> tracks, int index})?> resolvePlay(String mediaId) async {
    final parsed = _parseTrackId(mediaId);
    if (parsed == null) return null;
    final tracks = await _tracksFor(parsed.ctx);
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
      final most = await _tracksFor('most');
      debugPrint('[AA] searchItems("") -> most-played (${most.length})');
      return most.map((t) => _trackItem(t, 'most')).toList();
    }
    final tracks = await api.tracks(q: q, limit: 50);
    debugPrint('[AA] searchItems("$q") -> ${tracks.length} tracks (loggedIn=${api.isLoggedIn})');
    return tracks.map((t) => _trackItem(t, 'q:$q')).toList();
  }

  ({String ctx, String trackId})? _parseTrackId(String mediaId) {
    // tk::<ctx>::<trackId>  (ctx may contain a single ':' for "pl:<id>")
    final body = mediaId.substring('tk::'.length);
    final sep = body.lastIndexOf('::');
    if (sep < 0) return null;
    return (ctx: body.substring(0, sep), trackId: body.substring(sep + 2));
  }

  Future<List<Track>> _tracksFor(String ctx) async {
    if (ctx == 'songs') return api.tracks();
    if (ctx == 'liked') return (await api.liked()).tracks;
    if (ctx == 'recent') return api.recentlyPlayed();
    if (ctx == 'most') return api.mostPlayed();
    if (ctx.startsWith('pl:')) return (await api.playlist(ctx.substring(3))).tracks;
    if (ctx.startsWith('q:')) return api.tracks(q: ctx.substring(2), limit: 50);
    return const [];
  }
}
