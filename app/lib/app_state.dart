import 'dart:async';

import 'package:flutter/foundation.dart';
import 'api.dart';
import 'auto_browse.dart';
import 'models.dart';

/// Top-level auth/session state.
class AppState extends ChangeNotifier {
  final Api api;
  AppUser? user;
  bool loading = true;
  bool offline = false; // server unreachable — run in offline (downloads-only) mode
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

  /// Re-fetch liked ids (e.g. after uploading, which auto-likes).
  Future<void> reloadLiked() => _loadLiked();

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

  /// Restore a saved session on startup. If the server is unreachable, enter
  /// offline mode instead of trying (and failing) to verify credentials — so a
  /// user with downloads is never locked out, even if their session expired.
  Future<void> bootstrap() async {
    await api.load();
    // Offline (downloads-only) mode is a fallback for users who already configured
    // a server — never trap a fresh / logged-out-without-server install here; it
    // must reach the login screen (where the server URL is entered) even with no
    // connectivity. So only fall offline if there's a prior session to fall back to.
    final hadSession = api.isLoggedIn || api.baseUrl.isNotEmpty;
    if (hadSession && !await api.isOnline()) {
      offline = true;
      loading = false;
      notifyListeners();
      return;
    }
    offline = false;
    if (api.isLoggedIn) {
      user = await api.me();
      if (user != null) _loadLiked();
    }
    loading = false;
    notifyListeners();
  }

  /// Retry reaching the server from offline mode. Returns true once back online.
  Future<bool> retryConnect() async {
    if (!await api.isOnline()) return false;
    offline = false;
    if (api.isLoggedIn) {
      user = await api.me();
      if (user != null) _loadLiked();
    }
    notifyListeners();
    return true;
  }

  Future<void> login(String url, String username, String password) async {
    user = await api.login(url, username, password);
    offline = false;
    _loadLiked();
    // Now authed — push the library to any connected Android Auto head unit so its
    // home fills in without needing an app restart.
    unawaited(refreshAndroidAutoBrowse());
    notifyListeners();
  }

  Future<void> logout() async {
    await api.clearTokens();
    user = null;
    _liked.clear();
    notifyListeners();
  }
}
