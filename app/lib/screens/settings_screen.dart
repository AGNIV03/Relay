import 'dart:io' show Platform, Process;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:url_launcher/url_launcher.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../downloads.dart';
import '../feature_models.dart';
import '../settings.dart';
import '../theme.dart';
import 'profile_screen.dart' show showPrivacySheet, signOutEverywhere;

const _red = Color(0xFFEF4444);

String formatBytes(int b) {
  if (b < 1024) return '$b B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  var v = b / 1024;
  var i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return '${v.toStringAsFixed(v >= 100 ? 0 : 1)} ${units[i]}';
}

/// Open [url] in the system browser. Returns false if that fails, so the caller
/// can offer the link to copy instead.
Future<bool> openInBrowser(String url) async {
  if (kIsWeb || !url.startsWith('https://')) return false;
  try {
    if (Platform.isAndroid) {
      return await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    }
    if (Platform.isWindows) {
      await Process.start('rundll32', ['url.dll,FileProtocolHandler', url]);
      return true;
    }
    if (Platform.isMacOS) {
      await Process.start('open', [url]);
      return true;
    }
    if (Platform.isLinux) {
      await Process.start('xdg-open', [url]);
      return true;
    }
  } catch (_) {}
  return false;
}

/// App settings: playback, downloads, scrobbling and account. Reached from
/// Profile (mobile tab and the desktop profile page).
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final downloads = context.watch<DownloadManager>();
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListenableBuilder(
        listenable: AppSettings.instance,
        builder: (context, _) {
          final s = AppSettings.instance;
          return ListView(
            padding: const EdgeInsets.only(bottom: 32),
            children: [
              const _Header('Playback'),
              _Card(children: [
                SwitchListTile(
                  value: s.autoplay,
                  onChanged: s.setAutoplay,
                  title: const Text('Autoplay'),
                  subtitle: const Text('Keep playing similar songs when your queue ends.'),
                ),
                SwitchListTile(
                  value: s.normalize,
                  onChanged: s.setNormalize,
                  title: const Text('Normalize volume'),
                  subtitle: const Text('Even out loudness between songs. Never louder than '
                      'your volume setting.'),
                ),
                ListTile(
                  title: const Text('Fade between songs'),
                  trailing: Text(s.fadeSeconds == 0 ? 'Off' : '${s.fadeSeconds}s',
                      style: const TextStyle(color: kAccent, fontWeight: FontWeight.w600)),
                  subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Slider(
                      value: s.fadeSeconds.toDouble(),
                      min: 0,
                      max: 12,
                      divisions: 12,
                      label: s.fadeSeconds == 0 ? 'Off' : '${s.fadeSeconds}s',
                      onChanged: (v) => s.setFadeSeconds(v.round()),
                    ),
                    const Text(
                      'Songs overlap: the next one fades in as the current one fades out.',
                      style: TextStyle(fontSize: 12, color: kMuted),
                    ),
                  ]),
                ),
              ]),
              if (downloads.supported) ...[
                const _Header('Downloads'),
                _Card(children: [
                  SwitchListTile(
                    value: s.downloadWifiOnly,
                    onChanged: s.setDownloadWifiOnly,
                    title: const Text('Download on Wi-Fi only'),
                    subtitle: Text(downloads.pausedForWifi
                        ? 'Paused until you are on Wi-Fi.'
                        : 'Downloads wait while you are on mobile data.'),
                  ),
                  const _StorageTile(),
                ]),
              ],
              const _Header('Scrobbling'),
              const _ScrobblingCard(),
              const _Header('Account'),
              _Card(children: [
                ListTile(
                  leading: const Icon(Icons.shield_outlined, size: 20),
                  title: const Text('Privacy & sharing'),
                  onTap: () => showPrivacySheet(context),
                ),
                ListTile(
                  leading: const Icon(Icons.devices_other, size: 20, color: _red),
                  title: const Text('Sign out of all devices',
                      style: TextStyle(color: _red, fontWeight: FontWeight.w500)),
                  onTap: () => signOutEverywhere(context),
                ),
              ]),
            ],
          );
        },
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final String text;
  const _Header(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 6),
        child: Text(text,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: kMuted)),
      );
}

class _Card extends StatelessWidget {
  final List<Widget> children;
  const _Card({required this.children});
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          color: kPanel,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: kBorder),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(mainAxisSize: MainAxisSize.min, children: children),
      );
}

/// Storage used by downloads + "Remove all downloads".
class _StorageTile extends StatefulWidget {
  const _StorageTile();
  @override
  State<_StorageTile> createState() => _StorageTileState();
}

class _StorageTileState extends State<_StorageTile> {
  late Future<int> _bytes = context.read<DownloadManager>().storageBytes();
  bool _removing = false;

  Future<void> _removeAll() async {
    final downloads = context.read<DownloadManager>();
    final messenger = ScaffoldMessenger.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: kPanel,
        title: const Text('Remove all downloads?'),
        content: const Text('Every downloaded song and playlist will be deleted from this '
            'device. You can download them again any time.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Remove all', style: TextStyle(color: _red)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _removing = true);
    await downloads.removeEverything();
    if (!mounted) return;
    setState(() {
      _removing = false;
      _bytes = downloads.storageBytes();
    });
    messenger.showSnackBar(const SnackBar(content: Text('All downloads removed')));
  }

  @override
  Widget build(BuildContext context) {
    final downloads = context.watch<DownloadManager>();
    return Column(mainAxisSize: MainAxisSize.min, children: [
      ListTile(
        title: const Text('Storage used'),
        subtitle: Text('${downloads.offlineTracks.length} songs downloaded'),
        trailing: FutureBuilder<int>(
          future: _bytes,
          builder: (_, snap) => Text(
            snap.hasData ? formatBytes(snap.data!) : '…',
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
        ),
        onTap: () => setState(() => _bytes = downloads.storageBytes()),
      ),
      ListTile(
        leading: _removing
            ? const SizedBox(
                width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
            : const Icon(Icons.delete_sweep_outlined, size: 20, color: _red),
        title: const Text('Remove all downloads',
            style: TextStyle(color: _red, fontWeight: FontWeight.w500)),
        enabled: !_removing && downloads.hasDownloads,
        onTap: _removeAll,
      ),
    ]);
  }
}

/// ListenBrainz (paste a token) and Last.fm (approve in a browser) accounts.
class _ScrobblingCard extends StatefulWidget {
  const _ScrobblingCard();
  @override
  State<_ScrobblingCard> createState() => _ScrobblingCardState();
}

class _ScrobblingCardState extends State<_ScrobblingCard> {
  ScrobblingStatus? _status;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final s = await context.read<Api>().scrobbling();
      if (mounted) {
        setState(() {
          _status = s;
          _error = null;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't load scrobbling settings");
    }
  }

  Future<void> _run(Future<ScrobblingStatus> Function() f) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      final s = await f();
      if (mounted) setState(() => _status = s);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _connectListenBrainz() async {
    final api = context.read<Api>();
    final token = TextEditingController();
    final result = await showDialog<ScrobblingStatus>(
      context: context,
      builder: (ctx) {
        String? error;
        var saving = false;
        return StatefulBuilder(
          builder: (ctx, setLocal) => AlertDialog(
            backgroundColor: kPanel,
            title: const Text('Connect ListenBrainz'),
            content: Column(mainAxisSize: MainAxisSize.min, children: [
              const Text(
                'Paste your user token from listenbrainz.org, under Settings. '
                'Your plays will be sent to your ListenBrainz profile.',
                style: TextStyle(color: kMuted, fontSize: 13),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: token,
                autofocus: true,
                decoration: const InputDecoration(labelText: 'User token'),
              ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(error!, style: const TextStyle(color: _red, fontSize: 13)),
                ),
            ]),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
              TextButton(
                onPressed: saving
                    ? null
                    : () async {
                        if (token.text.trim().isEmpty) return;
                        setLocal(() {
                          saving = true;
                          error = null;
                        });
                        try {
                          final s = await api.connectListenBrainz(token.text);
                          if (ctx.mounted) Navigator.pop(ctx, s);
                        } catch (e) {
                          setLocal(() {
                            saving = false;
                            error = '$e';
                          });
                        }
                      },
                child: Text(saving ? 'Checking…' : 'Connect'),
              ),
            ],
          ),
        );
      },
    );
    if (result != null && mounted) setState(() => _status = result);
  }

  Future<void> _connectLastfm() async {
    final api = context.read<Api>();
    final messenger = ScaffoldMessenger.of(context);
    ({String authUrl, String token}) start;
    setState(() => _busy = true);
    try {
      start = await api.startLastfm();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("Couldn't start Last.fm sign-in: $e")));
      return;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (!mounted) return;
    final opened = await openInBrowser(start.authUrl);
    if (!mounted) return;
    final result = await showDialog<ScrobblingStatus>(
      context: context,
      builder: (ctx) {
        String? error;
        var checking = false;
        return StatefulBuilder(
          builder: (ctx, setLocal) => AlertDialog(
            backgroundColor: kPanel,
            title: const Text('Connect Last.fm'),
            content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(
                opened
                    ? 'Approve Relay in the browser window that just opened, then come back here.'
                    : 'Open this link in a browser, approve Relay, then come back here.',
                style: const TextStyle(color: kMuted, fontSize: 13),
              ),
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: kPanel2,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: kBorder),
                ),
                child: SelectableText(start.authUrl, style: const TextStyle(fontSize: 12)),
              ),
              const SizedBox(height: 6),
              Row(children: [
                TextButton.icon(
                  icon: const Icon(Icons.copy, size: 16),
                  label: const Text('Copy link'),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: start.authUrl));
                    messenger.showSnackBar(const SnackBar(
                        content: Text('Link copied'), duration: Duration(seconds: 1)));
                  },
                ),
                if (!kIsWeb && !Platform.isAndroid && !Platform.isIOS)
                  TextButton.icon(
                    icon: const Icon(Icons.open_in_new, size: 16),
                    label: const Text('Open again'),
                    onPressed: () => openInBrowser(start.authUrl),
                  ),
              ]),
              if (error != null)
                Text(error!, style: const TextStyle(color: _red, fontSize: 13)),
            ]),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
              FilledButton(
                onPressed: checking
                    ? null
                    : () async {
                        setLocal(() {
                          checking = true;
                          error = null;
                        });
                        try {
                          final s = await api.completeLastfm(start.token);
                          if (ctx.mounted) Navigator.pop(ctx, s);
                        } catch (e) {
                          setLocal(() {
                            checking = false;
                            error = e is ApiException && e.status == 400
                                ? "Last.fm hasn't confirmed yet. Approve it in the browser, then try again."
                                : '$e';
                          });
                        }
                      },
                child: Text(checking ? 'Checking…' : "I've approved it"),
              ),
            ],
          ),
        );
      },
    );
    if (result != null && mounted) setState(() => _status = result);
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<Api>();
    final s = _status;
    if (s == null) {
      return _Card(children: [
        ListTile(
          title: Text(_error ?? 'Loading…', style: const TextStyle(color: kMuted)),
          trailing: _error == null
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : TextButton(onPressed: _refresh, child: const Text('Retry')),
        ),
      ]);
    }
    return _Card(children: [
      ListTile(
        leading: const Icon(Icons.graphic_eq, size: 20),
        title: const Text('ListenBrainz'),
        subtitle: Text(s.listenBrainzConnected
            ? 'Connected${s.listenBrainzUser != null ? ' as ${s.listenBrainzUser}' : ''}'
            : 'Send your plays to ListenBrainz'),
        trailing: s.listenBrainzConnected
            ? TextButton(
                onPressed: _busy ? null : () => _run(api.disconnectListenBrainz),
                child: const Text('Disconnect', style: TextStyle(color: _red)),
              )
            : TextButton(
                onPressed: _busy ? null : _connectListenBrainz,
                child: const Text('Connect'),
              ),
      ),
      if (s.lastfmAvailable || s.lastfmConnected)
        ListTile(
          leading: const Icon(Icons.radio, size: 20),
          title: const Text('Last.fm'),
          subtitle: Text(s.lastfmConnected
              ? 'Connected${s.lastfmUser != null ? ' as ${s.lastfmUser}' : ''}'
              : 'Scrobble your plays to Last.fm'),
          trailing: s.lastfmConnected
              ? TextButton(
                  onPressed: _busy ? null : () => _run(api.disconnectLastfm),
                  child: const Text('Disconnect', style: TextStyle(color: _red)),
                )
              : TextButton(
                  onPressed: _busy ? null : _connectLastfm,
                  child: const Text('Connect'),
                ),
        ),
    ]);
  }
}
