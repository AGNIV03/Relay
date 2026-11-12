// Data models for the newer endpoints (search groups, scrobbling accounts,
// playlist import, per-file upload results). Kept apart from models.dart so the
// core DTOs stay small.
import 'models.dart';

/// A playlist hit from the grouped search (the user's own, collaborative and
/// public playlists matching by name).
class PlaylistHit {
  final String id;
  final String name;
  final int trackCount;
  final String? ownerName;
  PlaylistHit({required this.id, required this.name, this.trackCount = 0, this.ownerName});

  factory PlaylistHit.fromJson(Map<String, dynamic> j) => PlaylistHit(
        id: j['id'] as String,
        name: j['name'] as String? ?? 'Playlist',
        trackCount: (j['trackCount'] ?? j['_count']?['tracks'] ?? 0) as int,
        ownerName: (j['ownerName'] ?? j['owner']?['username']) as String?,
      );
}

/// GET /api/search?q= → {tracks, albums, artists, playlists}.
class SearchResults {
  final List<Track> tracks;
  final List<Album> albums;
  final List<Artist> artists;
  final List<PlaylistHit> playlists;
  const SearchResults({
    this.tracks = const [],
    this.albums = const [],
    this.artists = const [],
    this.playlists = const [],
  });

  static const empty = SearchResults();

  bool get hasGroups => albums.isNotEmpty || artists.isNotEmpty || playlists.isNotEmpty;

  factory SearchResults.fromJson(Map<String, dynamic> j) {
    List<T> list<T>(String k, T Function(Map<String, dynamic>) f) => [
          for (final e in (j[k] as List?) ?? const [])
            if (e is Map) f(e.cast<String, dynamic>()),
        ];
    return SearchResults(
      tracks: list('tracks', Track.fromJson),
      albums: list('albums', Album.fromJson),
      artists: list('artists', Artist.fromJson),
      playlists: list('playlists', PlaylistHit.fromJson),
    );
  }
}

/// GET /api/scrobbling.
class ScrobblingStatus {
  final bool listenBrainzConnected;
  final String? listenBrainzUser;
  final bool lastfmConnected;
  final String? lastfmUser;
  final bool lastfmAvailable; // server has a Last.fm API key + secret configured

  const ScrobblingStatus({
    this.listenBrainzConnected = false,
    this.listenBrainzUser,
    this.lastfmConnected = false,
    this.lastfmUser,
    this.lastfmAvailable = false,
  });

  factory ScrobblingStatus.fromJson(Map<String, dynamic> j) {
    final lb = (j['listenbrainz'] as Map?) ?? const {};
    final lf = (j['lastfm'] as Map?) ?? const {};
    return ScrobblingStatus(
      listenBrainzConnected: lb['connected'] == true,
      listenBrainzUser: lb['username'] as String?,
      lastfmConnected: lf['connected'] == true,
      lastfmUser: lf['username'] as String?,
      lastfmAvailable: lf['available'] == true,
    );
  }
}

/// POST /api/playlists/import result.
class ImportResult {
  final String playlistId;
  final int matched;
  final int total;
  final List<String> unmatched;
  ImportResult(
      {required this.playlistId, required this.matched, required this.total, required this.unmatched});

  factory ImportResult.fromJson(Map<String, dynamic> j) => ImportResult(
        playlistId: j['playlistId'] as String,
        matched: (j['matched'] ?? 0) as int,
        total: (j['total'] ?? 0) as int,
        unmatched: [for (final u in (j['unmatched'] as List?) ?? const []) '$u'],
      );
}

/// Final outcome of one uploaded file.
enum UploadStatus { added, duplicate, rejected, failed }

class UploadFileResult {
  final String name;
  final UploadStatus status;
  final String? reason;
  const UploadFileResult(this.name, this.status, [this.reason]);
}
