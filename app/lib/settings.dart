import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// User preferences shared across the app (persisted in SharedPreferences).
/// Playback reads autoplay / normalize / fadeSeconds; downloads read wifiOnly;
/// the search UI reads/writes recentSearches. The Settings screen edits them.
class AppSettings extends ChangeNotifier {
  AppSettings._();
  static final AppSettings instance = AppSettings._();

  static const _kAutoplay = 'set_autoplay';
  static const _kNormalize = 'set_normalize';
  static const _kFade = 'set_fade_seconds';
  static const _kWifiOnly = 'set_dl_wifi_only';
  static const _kRecent = 'set_recent_searches';

  /// Keep playing similar songs when the queue runs out.
  bool autoplay = true;

  /// Even out loudness between songs (attenuation only — never boosts).
  bool normalize = true;

  /// Fade between songs, in seconds (0 = off). Where the platform supports a
  /// true overlap this is a crossfade; elsewhere a short fade-out / fade-in.
  int fadeSeconds = 0;

  /// Only download over Wi-Fi / unmetered connections.
  bool downloadWifiOnly = false;

  /// Most recent first, max [maxRecent].
  List<String> recentSearches = [];
  static const maxRecent = 12;

  bool _loaded = false;

  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      autoplay = p.getBool(_kAutoplay) ?? autoplay;
      normalize = p.getBool(_kNormalize) ?? normalize;
      fadeSeconds = p.getInt(_kFade) ?? fadeSeconds;
      downloadWifiOnly = p.getBool(_kWifiOnly) ?? downloadWifiOnly;
      recentSearches = p.getStringList(_kRecent) ?? recentSearches;
    } catch (_) {}
    notifyListeners();
  }

  Future<void> _save() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setBool(_kAutoplay, autoplay);
      await p.setBool(_kNormalize, normalize);
      await p.setInt(_kFade, fadeSeconds);
      await p.setBool(_kWifiOnly, downloadWifiOnly);
      await p.setStringList(_kRecent, recentSearches);
    } catch (_) {}
  }

  void setAutoplay(bool v) => _set(() => autoplay = v);
  void setNormalize(bool v) => _set(() => normalize = v);
  void setFadeSeconds(int v) => _set(() => fadeSeconds = v.clamp(0, 12));
  void setDownloadWifiOnly(bool v) => _set(() => downloadWifiOnly = v);

  void addRecentSearch(String q) {
    final t = q.trim();
    if (t.isEmpty) return;
    _set(() {
      recentSearches = [t, ...recentSearches.where((s) => s.toLowerCase() != t.toLowerCase())]
          .take(maxRecent)
          .toList();
    });
  }

  void removeRecentSearch(String q) =>
      _set(() => recentSearches = recentSearches.where((s) => s != q).toList());
  void clearRecentSearches() => _set(() => recentSearches = []);

  void _set(VoidCallback f) {
    f();
    notifyListeners();
    _save();
  }
}
