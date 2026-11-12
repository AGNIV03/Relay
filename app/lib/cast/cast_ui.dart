import 'dart:async';

import 'package:flutter/material.dart';
import 'package:material_symbols_icons/symbols.dart';
import 'package:provider/provider.dart';

import '../player.dart';
import '../theme.dart';
import 'cast_discovery.dart';

/// Cast icon: opens the device picker; highlighted while casting. Hidden where
/// casting isn't possible (Chorus member, listen-along).
class CastButton extends StatelessWidget {
  final double size;
  const CastButton({super.key, this.size = 22});

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    if (!player.canCast && !player.casting) return const SizedBox.shrink();
    final connecting = player.cast.connecting;
    return IconButton(
      tooltip: player.casting ? 'Casting to ${player.castDeviceName}' : 'Cast',
      iconSize: size,
      icon: connecting
          ? SizedBox(
              width: size * 0.8,
              height: size * 0.8,
              child: const CircularProgressIndicator(strokeWidth: 2))
          : Icon(player.casting ? Symbols.cast_connected : Symbols.cast,
              color: player.casting ? kAccent : kMuted),
      onPressed: () => showCastPicker(context),
    );
  }
}

/// The "Casting to (device)" line, shown under the player controls while casting.
class CastingLabel extends StatelessWidget {
  final double fontSize;
  const CastingLabel({super.key, this.fontSize = 12});

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    if (!player.casting) return const SizedBox.shrink();
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(Symbols.cast_connected, size: fontSize + 2, color: kAccent),
      const SizedBox(width: 6),
      Flexible(
        child: Text('Casting to ${player.castDeviceName}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: kAccent, fontSize: fontSize, fontWeight: FontWeight.w600)),
      ),
    ]);
  }
}

/// Device picker: a bottom sheet on phones, a dialog on wide (desktop) layouts.
Future<void> showCastPicker(BuildContext context) {
  final wide = MediaQuery.of(context).size.width >= 700;
  if (wide) {
    return showDialog<void>(
      context: context,
      builder: (_) => const Dialog(
        backgroundColor: kPanel,
        child: SizedBox(width: 380, child: _CastPicker()),
      ),
    );
  }
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: kPanel,
    showDragHandle: true,
    builder: (_) => const SafeArea(child: _CastPicker()),
  );
}

class _CastPicker extends StatefulWidget {
  const _CastPicker();
  @override
  State<_CastPicker> createState() => _CastPickerState();
}

class _CastPickerState extends State<_CastPicker> {
  final List<CastDevice> _devices = [];
  StreamSubscription<CastDevice>? _scan;
  bool _scanning = false;
  String? _error;
  CastDevice? _connecting;

  @override
  void initState() {
    super.initState();
    if (!context.read<PlayerModel>().casting) _startScan();
  }

  void _startScan() {
    _scan?.cancel();
    setState(() {
      _devices.clear();
      _scanning = true;
      _error = null;
    });
    _scan = context.read<PlayerModel>().scanCastDevices().listen(
      (d) {
        if (!mounted || _devices.contains(d)) return;
        setState(() => _devices
          ..add(d)
          ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase())));
      },
      onError: (Object e) {
        if (mounted) setState(() => _error = 'Could not search the network');
      },
      onDone: () {
        if (mounted) setState(() => _scanning = false);
      },
    );
  }

  Future<void> _connect(CastDevice d) async {
    final player = context.read<PlayerModel>();
    final nav = Navigator.of(context);
    setState(() {
      _connecting = d;
      _error = null;
    });
    try {
      await player.startCasting(d);
      if (mounted) nav.pop();
    } catch (_) {
      if (mounted) {
        setState(() {
          _connecting = null;
          _error = 'Could not connect to ${d.name}';
        });
      }
    }
  }

  @override
  void dispose() {
    _scan?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerModel>();
    if (player.casting) return _connected(player);
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 4, 4),
            child: Row(children: [
              const Expanded(
                child: Text('Cast to a device',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
              ),
              if (_scanning)
                const SizedBox(
                    width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              else
                IconButton(
                  tooltip: 'Search again',
                  icon: const Icon(Symbols.refresh, size: 20),
                  onPressed: _startScan,
                ),
            ]),
          ),
          if (_devices.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 18),
              child: Text(
                _scanning
                    ? 'Looking for Chromecast and Google TV devices on your network...'
                    : 'No devices found. Make sure the device is on the same Wi-Fi network.',
                style: const TextStyle(color: kMuted),
              ),
            ),
          for (final d in _devices)
            ListTile(
              leading: const Icon(Symbols.tv),
              title: Text(d.name, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: d.model == null ? null : Text(d.model!, style: const TextStyle(color: kMuted)),
              trailing: _connecting == d
                  ? const SizedBox(
                      width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : null,
              onTap: _connecting == null ? () => _connect(d) : null,
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: Text(_error!, style: const TextStyle(color: Colors.redAccent)),
            ),
        ],
      ),
    );
  }

  Widget _connected(PlayerModel player) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(children: [
            const Icon(Symbols.cast_connected, color: kAccent),
            const SizedBox(width: 10),
            Expanded(
              child: Text('Casting to ${player.castDeviceName}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            ),
          ]),
          const SizedBox(height: 12),
          Row(children: [
            const Icon(Symbols.volume_up, size: 18, color: kMuted),
            Expanded(
              child: Slider(
                value: player.volume.clamp(0.0, 1.0),
                onChanged: player.setVolume,
              ),
            ),
          ]),
          if (player.cast.error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(player.cast.error!, style: const TextStyle(color: Colors.redAccent)),
            ),
          FilledButton.icon(
            onPressed: () async {
              final nav = Navigator.of(context);
              await player.stopCasting();
              if (mounted) nav.pop();
            },
            icon: const Icon(Symbols.cast),
            label: const Text('Stop casting'),
          ),
        ],
      ),
    );
  }
}
