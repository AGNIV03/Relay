import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:just_audio_background/just_audio_background.dart';

import 'api.dart';
import 'models.dart';

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
    if (parentId == 'recent') {
      final tracks = await _tracksFor('recent');
      return tracks.map((t) => _trackItem(t, 'recent')).toList();
    }
    if (parentId == _root) {
      // Spotify-style home. The first tiles are STATIC (no network), so the root
      // is never empty even if Android Auto queries during the cold isolate-startup
      // race or before the API token has loaded — that empty result is what AA
      // caches and shows as "No items". Playlists are then added inline, best-effort;
      // a fetch failure must never empty the home, so it's caught.
      final items = <MediaItem>[
        _cat('cat::liked', 'Liked Songs', style: _grid),
        _cat('cat::recent', 'Recently Played', style: _grid),
        _cat('cat::most', 'Most Played', style: _grid),
        _cat('cat::songs', 'All Songs', style: _grid),
      ];
      try {
        final pls = await api.playlists();
        for (final p in pls) {
          items.add(MediaItem(
            id: 'pl::${p.id}',
            title: p.name,
            playable: false,
            artUri: Uri.parse(api.playlistCoverUrl(p.id)),
            extras: _grid,
          ));
        }
      } catch (e) {
        debugPrint('[AA] root: playlists fetch failed, showing folder instead: $e');
        items.add(_cat('cat::playlists', 'Playlists', style: _grid));
      }
      debugPrint('[AA] getChildren("root") -> ${items.length} items');
      return items;
    }
    if (parentId == 'cat::playlists') {
      final pls = await api.playlists();
      return pls
          .map((p) => MediaItem(
                id: 'pl::${p.id}',
                title: p.name,
                playable: false,
                extras: _grid,
              ))
          .toList();
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
    if (q.isEmpty) return const [];
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
