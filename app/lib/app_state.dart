import 'package:flutter/foundation.dart';
import 'api.dart';
import 'models.dart';

/// Top-level auth/session state.
class AppState extends ChangeNotifier {
  final Api api;
  AppUser? user;
  bool loading = true;
  final Set<String> _liked = {};

  AppState(this.api);

  bool get isLoggedIn => user != null;
  bool isLiked(String trackId) => _liked.contains(trackId);

  Future<void> _loadLiked() async {
    try {
      final ids = await api.likedIds();
      _liked
        ..clear()
        ..addAll(ids);
      notifyListeners();
    } catch (_) {}
  }

  /// Like / unlike a track (optimistic).
  Future<void> toggleLike(String trackId) async {
    final wasLiked = _liked.contains(trackId);
    if (wasLiked) {
      _liked.remove(trackId);
    } else {
      _liked.add(trackId);
    }
    notifyListeners();
    try {
      if (wasLiked) {
        await api.unlike(trackId);
      } else {
        await api.like(trackId);
      }
    } catch (_) {
      // revert
      if (wasLiked) {
        _liked.add(trackId);
      } else {
        _liked.remove(trackId);
      }
      notifyListeners();
    }
  }

  /// Restore a saved session on startup.
  Future<void> bootstrap() async {
    await api.load();
    if (api.isLoggedIn) {
      user = await api.me();
      if (user != null) _loadLiked();
    }
    loading = false;
    notifyListeners();
  }

  Future<void> login(String url, String username, String password) async {
    user = await api.login(url, username, password);
    _loadLiked();
    notifyListeners();
  }

  Future<void> logout() async {
    await api.clearTokens();
    user = null;
    _liked.clear();
    notifyListeners();
  }
}
