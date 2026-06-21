// Plain data models mirroring the server's JSON DTOs.

class Artist {
  final String id;
  final String name;
  final int albumCount;
  final int trackCount;

  Artist({required this.id, required this.name, this.albumCount = 0, this.trackCount = 0});

  factory Artist.fromJson(Map<String, dynamic> j) => Artist(
        id: j['id'] as String,
        name: j['name'] as String? ?? 'Unknown',
        albumCount: (j['_count']?['albums'] ?? 0) as int,
        trackCount: (j['_count']?['tracks'] ?? 0) as int,
      );
}

class Album {
  final String id;
  final String title;
  final int? year;
  final Artist? artist;
  final int trackCount;
  final List<Track> tracks;

  Album({
    required this.id,
    required this.title,
    this.year,
    this.artist,
    this.trackCount = 0,
    this.tracks = const [],
  });

  factory Album.fromJson(Map<String, dynamic> j) => Album(
        id: j['id'] as String,
        title: j['title'] as String? ?? 'Unknown Album',
        year: j['year'] as int?,
        artist: j['artist'] != null ? Artist.fromJson(j['artist']) : null,
        trackCount: (j['_count']?['tracks'] ?? (j['tracks'] as List?)?.length ?? 0) as int,
        tracks: (j['tracks'] as List?)?.map((t) => Track.fromJson(t)).toList() ?? const [],
      );
}

class Track {
  final String id;
  final String title;
  final double duration;
  final int? trackNo;
  final String? format;
  final int? bitrate;
  final int? playCount;
  final Artist? artist;
  final Album? album;
  final String? uploaderName;

  Track({
    required this.id,
    required this.title,
    required this.duration,
    this.trackNo,
    this.format,
    this.bitrate,
    this.playCount,
    this.artist,
    this.album,
    this.uploaderName,
  });

  factory Track.fromJson(Map<String, dynamic> j) => Track(
        id: j['id'] as String,
        title: j['title'] as String? ?? 'Untitled',
        duration: (j['duration'] as num?)?.toDouble() ?? 0,
        trackNo: j['trackNo'] as int?,
        format: j['format'] as String?,
        bitrate: j['bitrate'] as int?,
        playCount: j['playCount'] as int?,
        artist: j['artist'] != null ? Artist.fromJson(j['artist']) : null,
        album: j['album'] != null ? Album.fromJson(j['album']) : null,
        uploaderName: j['uploader']?['username'] as String?,
      );

  String get artistName => artist?.name ?? '';
  String get albumTitle => album?.title ?? '';

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'duration': duration,
        'trackNo': trackNo,
        'format': format,
        'bitrate': bitrate,
        'artist': artist == null ? null : {'id': artist!.id, 'name': artist!.name},
        'album': album == null
            ? null
            : {'id': album!.id, 'title': album!.title, 'year': album!.year},
      };
}

class WrappedStats {
  final int totalPlays;
  final int totalMinutes;
  final int distinctTracks;
  final List<({String name, int count})> topArtists;
  final List<({String name, int count})> topGenres;
  final List<({String title, String artist, int playCount})> topTracks;

  WrappedStats({
    required this.totalPlays,
    required this.totalMinutes,
    required this.distinctTracks,
    required this.topArtists,
    required this.topGenres,
    required this.topTracks,
  });

  factory WrappedStats.fromJson(Map<String, dynamic> j) => WrappedStats(
        totalPlays: j['totalPlays'] as int? ?? 0,
        totalMinutes: j['totalMinutes'] as int? ?? 0,
        distinctTracks: j['distinctTracks'] as int? ?? 0,
        topArtists: ((j['topArtists'] as List?) ?? [])
            .map((e) => (name: e['name'] as String, count: e['count'] as int))
            .toList(),
        topGenres: ((j['topGenres'] as List?) ?? [])
            .map((e) => (name: e['name'] as String, count: e['count'] as int))
            .toList(),
        topTracks: ((j['topTracks'] as List?) ?? [])
            .map((e) => (
                  title: e['title'] as String,
                  artist: e['artist'] as String,
                  playCount: e['playCount'] as int
                ))
            .toList(),
      );
}

class Lyrics {
  final String? synced;
  final String? plain;
  Lyrics({this.synced, this.plain});
  factory Lyrics.fromJson(Map<String, dynamic> j) =>
      Lyrics(synced: j['synced'] as String?, plain: j['plain'] as String?);
}

class Playlist {
  final String id;
  final String name;
  final int trackCount;
  final List<Track> tracks;

  Playlist({required this.id, required this.name, this.trackCount = 0, this.tracks = const []});

  factory Playlist.fromJson(Map<String, dynamic> j) => Playlist(
        id: j['id'] as String,
        name: j['name'] as String,
        trackCount: (j['_count']?['tracks'] ?? 0) as int,
        tracks: (j['tracks'] as List?)
                ?.map((pt) => Track.fromJson(pt['track']))
                .toList() ??
            const [],
      );
}

class AppUser {
  final String id;
  final String username;
  final String role;
  AppUser({required this.id, required this.username, required this.role});
  factory AppUser.fromJson(Map<String, dynamic> j) =>
      AppUser(id: j['id'], username: j['username'], role: j['role']);
  bool get isAdmin => role == 'ADMIN';
}
