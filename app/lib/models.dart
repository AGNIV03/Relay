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
  final String? createdAt;

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
    this.createdAt,
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
        createdAt: j['createdAt'] as String?,
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
  final String? translated; // line-aligned English translation
  final String? lang; // detected source language code
  Lyrics({this.synced, this.plain, this.translated, this.lang});
  factory Lyrics.fromJson(Map<String, dynamic> j) => Lyrics(
        synced: j['synced'] as String?,
        plain: j['plain'] as String?,
        translated: j['translated'] as String?,
        lang: j['lang'] as String?,
      );
}

class Playlist {
  final String id;
  final String name;
  final int trackCount;
  final List<Track> tracks;
  final bool owned; // false when the current user is only a collaborator/viewer
  final String? ownerName;
  final int collaboratorCount;
  final List<UserRef> collaborators; // populated by GET /:id (empty in list view)
  final Map<String, String?> addedAt; // trackId -> when it was added to this playlist
  final bool isPublic; // public "curated" playlist (shows in everyone's Home)

  Playlist({
    required this.id,
    required this.name,
    this.trackCount = 0,
    this.tracks = const [],
    this.owned = true,
    this.ownerName,
    this.collaboratorCount = 0,
    this.collaborators = const [],
    this.addedAt = const {},
    this.isPublic = false,
  });

  factory Playlist.fromJson(Map<String, dynamic> j) => Playlist(
        id: j['id'] as String,
        name: j['name'] as String,
        trackCount: (j['_count']?['tracks'] ?? 0) as int,
        tracks: (j['tracks'] as List?)
                ?.map((pt) => Track.fromJson(pt['track']))
                .toList() ??
            const [],
        owned: j['owned'] as bool? ?? true,
        ownerName: (j['ownerName'] ?? j['owner']?['username']) as String?,
        collaboratorCount:
            (j['collaboratorCount'] as int?) ?? (j['collaborators'] as List?)?.length ?? 0,
        collaborators: (j['collaborators'] as List?)
                ?.whereType<Map<String, dynamic>>()
                .map((e) => UserRef.fromJson(e))
                .toList() ??
            const [],
        addedAt: {
          for (final pt in (j['tracks'] as List? ?? []))
            if (pt['track']?['id'] != null) pt['track']['id'] as String: pt['addedAt'] as String?,
        },
        isPublic: j['isPublic'] as bool? ?? false,
      );
}

/// Lightweight public/curated playlist reference (Home "Curated playlists" +
/// grouped Recently Played). Not a full [Playlist] (no track list).
class PlaylistRef {
  final String id;
  final String name;
  final String ownerName;
  final String? coverPath;
  final int trackCount;
  PlaylistRef({
    required this.id,
    required this.name,
    required this.ownerName,
    this.coverPath,
    this.trackCount = 0,
  });
  factory PlaylistRef.fromJson(Map<String, dynamic> j) => PlaylistRef(
        id: j['id'] as String,
        name: j['name'] as String,
        ownerName: (j['ownerName'] ?? j['owner']?['username'] ?? '?') as String,
        coverPath: j['coverPath'] as String?,
        trackCount: (j['trackCount'] ?? j['_count']?['tracks'] ?? 0) as int,
      );
}

/// One entry in the grouped Recently Played feed: either a track or a playlist
/// (a track played from a playlist collapses into the playlist).
class RecentItem {
  final Track? track;
  final PlaylistRef? playlist;
  RecentItem({this.track, this.playlist});
  factory RecentItem.fromJson(Map<String, dynamic> j) => RecentItem(
        track: j['type'] == 'track' ? Track.fromJson(j['track']) : null,
        playlist: j['type'] == 'playlist' ? PlaylistRef.fromJson(j['playlist']) : null,
      );
}

class UserRef {
  final String id;
  final String username;
  UserRef({required this.id, required this.username});
  factory UserRef.fromJson(Map<String, dynamic> j) =>
      UserRef(id: j['id'] as String, username: j['username'] as String? ?? '?');
}

class UserProfile {
  final String id;
  final String username;
  final String role;
  final String? createdAt;
  final int likeCount;
  final List<Track> favorites;
  final List<Playlist> playlists;
  UserProfile({
    required this.id,
    required this.username,
    required this.role,
    this.createdAt,
    this.likeCount = 0,
    this.favorites = const [],
    this.playlists = const [],
  });
  factory UserProfile.fromJson(Map<String, dynamic> j) => UserProfile(
        id: j['id'] as String,
        username: j['username'] as String? ?? '?',
        role: j['role'] as String? ?? 'USER',
        createdAt: j['createdAt'] as String?,
        likeCount: (j['likeCount'] as int?) ?? 0,
        favorites:
            (j['favorites'] as List?)?.map((e) => Track.fromJson(e)).toList() ?? const [],
        playlists:
            (j['playlists'] as List?)?.map((e) => Playlist.fromJson(e)).toList() ?? const [],
      );
}

class Friend {
  final String id;
  final String username;
  final bool online;
  final bool playing;
  final Track? track;
  final String? chorusMode; // 'open' | 'ask' | null — they're hosting a Chorus
  final bool inChorusWithYou; // they share the chorus you're in
  final bool listeningToYou; // they're listening along to your playback
  Friend({
    required this.id,
    required this.username,
    required this.online,
    required this.playing,
    this.track,
    this.chorusMode,
    this.inChorusWithYou = false,
    this.listeningToYou = false,
  });
  factory Friend.fromJson(Map<String, dynamic> j) => Friend(
        id: j['id'] as String,
        username: j['username'] as String? ?? '?',
        online: j['online'] as bool? ?? false,
        playing: j['playing'] as bool? ?? false,
        track: j['track'] != null ? Track.fromJson(j['track']) : null,
        chorusMode: j['chorusMode'] as String?,
        inChorusWithYou: j['inChorusWithYou'] as bool? ?? false,
        listeningToYou: j['listeningToYou'] as bool? ?? false,
      );
}

/// A live Chorus session (collaborative synced listening).
class ChorusState {
  final String hostId;
  final String hostName;
  final String mode; // 'open' | 'ask'
  final bool isHost;
  final bool isPending; // I requested to join (ask mode), awaiting approval
  final List<UserRef> members;
  final List<UserRef> pending;
  final List<Track> queue;
  final List<String> queueIds;
  final int index;
  final int positionMs;
  final bool playing;
  final int updatedAt;
  final String controllerId;
  final String controllerName;
  final int version; // long-poll cursor
  final int serverNow; // server clock at hydrate, for skew-free extrapolation
  /// Pending member intents for the host to apply (host polls only).
  final List<ChorusPatch> commands;

  ChorusState({
    required this.hostId,
    required this.hostName,
    required this.mode,
    required this.isHost,
    this.isPending = false,
    required this.members,
    required this.pending,
    required this.queue,
    required this.queueIds,
    required this.index,
    required this.positionMs,
    required this.playing,
    required this.updatedAt,
    required this.controllerId,
    required this.controllerName,
    this.version = 0,
    this.serverNow = 0,
    this.commands = const [],
  });

  factory ChorusState.fromJson(Map<String, dynamic> j) => ChorusState(
        hostId: j['hostId'] as String,
        hostName: j['hostName'] as String? ?? '?',
        mode: j['mode'] as String? ?? 'open',
        isHost: j['isHost'] as bool? ?? false,
        isPending: j['isPending'] as bool? ?? false,
        members: (j['members'] as List?)?.map((e) => UserRef.fromJson(e)).toList() ?? const [],
        pending: (j['pending'] as List?)?.map((e) => UserRef.fromJson(e)).toList() ?? const [],
        queue: (j['queue'] as List?)?.map((e) => Track.fromJson(e)).toList() ?? const [],
        queueIds: (j['queueIds'] as List?)?.cast<String>() ?? const [],
        index: (j['index'] as int?) ?? 0,
        positionMs: (j['positionMs'] as int?) ?? 0,
        playing: j['playing'] as bool? ?? false,
        updatedAt: (j['updatedAt'] as int?) ?? 0,
        controllerId: j['controllerId'] as String? ?? '',
        controllerName: j['controllerName'] as String? ?? '?',
        version: (j['version'] as num?)?.toInt() ?? 0,
        serverNow: (j['serverNow'] as num?)?.toInt() ?? 0,
        commands: (j['commands'] as List?)?.map((e) => ChorusPatch.fromJson(e)).toList() ?? const [],
      );
}

/// A partial playback intent (a member command, or merged host target).
class ChorusPatch {
  final List<String>? queue;
  final int? index;
  final int? positionMs;
  final bool? playing;
  ChorusPatch({this.queue, this.index, this.positionMs, this.playing});
  factory ChorusPatch.fromJson(Map<String, dynamic> j) => ChorusPatch(
        queue: (j['queue'] as List?)?.cast<String>(),
        index: (j['index'] as num?)?.toInt(),
        positionMs: (j['positionMs'] as num?)?.toInt(),
        playing: j['playing'] as bool?,
      );
}

class HostActivity {
  final String? trackId;
  final Track? track;
  final int positionMs;
  final bool playing;
  final int? updatedAt;
  final bool online;
  final int version; // long-poll cursor
  final int serverNow; // server clock at response, for skew-free extrapolation
  HostActivity({
    this.trackId,
    this.track,
    this.positionMs = 0,
    this.playing = false,
    this.updatedAt,
    this.online = false,
    this.version = 0,
    this.serverNow = 0,
  });
  factory HostActivity.fromJson(Map<String, dynamic> j) => HostActivity(
        trackId: j['trackId'] as String?,
        track: j['track'] != null ? Track.fromJson(j['track']) : null,
        positionMs: (j['positionMs'] as num?)?.toInt() ?? 0,
        playing: j['playing'] as bool? ?? false,
        updatedAt: (j['updatedAt'] as num?)?.toInt(),
        online: j['online'] as bool? ?? false,
        version: (j['version'] as num?)?.toInt() ?? 0,
        serverNow: (j['serverNow'] as num?)?.toInt() ?? 0,
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
