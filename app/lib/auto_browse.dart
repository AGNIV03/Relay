import 'package:just_audio_background/just_audio_background.dart';

import 'api.dart';
import 'models.dart';

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

  MediaItem _cat(String id, String title) => MediaItem(
        id: id,
        title: title,
        playable: false,
        extras: _list,
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
    if (parentId == _root) {
      return [
        _cat('cat::songs', 'Songs'),
        _cat('cat::playlists', 'Playlists'),
        _cat('cat::liked', 'Liked Songs'),
        _cat('cat::recent', 'Recently Played'),
        _cat('cat::most', 'Most Played'),
      ];
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
