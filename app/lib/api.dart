import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
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

  // ---- Auth ----
  Future<AppUser> login(String url, String username, String password) async {
    baseUrl = url.replaceAll(RegExp(r'/$'), '');
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
  Future<void> createPlaylist(String name) =>
      _send('POST', '/api/playlists', body: {'name': name});
  Future<void> deletePlaylist(String id) => _send('DELETE', '/api/playlists/$id');
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
