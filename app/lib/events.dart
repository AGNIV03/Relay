import 'package:flutter/foundation.dart';

/// Bumped whenever the set of playlists changes (create / delete / rename) so any
/// visible playlist list (sidebar, grid) can refresh itself instead of going stale
/// until the app restarts.
final ValueNotifier<int> playlistsChanged = ValueNotifier<int>(0);

void notifyPlaylistsChanged() => playlistsChanged.value++;
