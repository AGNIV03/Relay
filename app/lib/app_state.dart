import 'package:flutter/foundation.dart';
import 'api.dart';
import 'models.dart';

/// Top-level auth/session state.
class AppState extends ChangeNotifier {
  final Api api;
  AppUser? user;
  bool loading = true;

  AppState(this.api);

  bool get isLoggedIn => user != null;

  /// Restore a saved session on startup.
  Future<void> bootstrap() async {
    await api.load();
    if (api.isLoggedIn) {
      user = await api.me();
    }
    loading = false;
    notifyListeners();
  }

  Future<void> login(String url, String username, String password) async {
    user = await api.login(url, username, password);
    notifyListeners();
  }

  Future<void> logout() async {
    await api.clearTokens();
    user = null;
    notifyListeners();
  }
}
