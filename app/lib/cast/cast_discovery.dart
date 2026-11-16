import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:multicast_dns/multicast_dns.dart';

/// A Cast receiver found on the local network.
class CastDevice {
  final String id; // TXT `id` (stable per device), else the service name
  final String name; // TXT `fn` friendly name, e.g. "Living Room TV"
  final String? model; // TXT `md`, e.g. "Chromecast"
  final String host;
  final int port;
  const CastDevice(
      {required this.id, required this.name, this.model, required this.host, required this.port});

  @override
  bool operator ==(Object other) => other is CastDevice && other.id == id;
  @override
  int get hashCode => id.hashCode;
}

/// mDNS discovery of `_googlecast._tcp` services (pure Dart via multicast_dns,
/// so the same code runs on Android and Windows). On Android a Wi-Fi multicast
/// lock is held while scanning, else most devices drop incoming multicast.
class CastDiscovery {
  static const _service = '_googlecast._tcp.local';
  static const _net = MethodChannel('relay/net');

  /// Scan for [timeout], yielding each device as soon as it resolves.
  static Stream<CastDevice> scan({Duration timeout = const Duration(seconds: 6)}) async* {
    if (kIsWeb) return;
    final seen = <String>{};
    final client = MDnsClient(rawDatagramSocketFactory: _bind);
    var locked = false;
    try {
      if (Platform.isAndroid) {
        try {
          await _net.invokeMethod('multicastLock');
          locked = true;
        } catch (e) {
          debugPrint('cast: multicast lock failed: $e');
        }
      }
      try {
        await client.start(interfacesFactory: _interfaces);
      } catch (e) {
        debugPrint('cast: mDNS start failed ($e), retrying on the default interface');
        await client.start(interfacesFactory: (_) async => (await _interfaces(InternetAddressType.IPv4)).take(1));
      }
      final ptrs = client.lookup<PtrResourceRecord>(
          ResourceRecordQuery.serverPointer(_service),
          timeout: timeout);
      final pending = <Future<CastDevice?>>[];
      final out = StreamController<CastDevice>();
      ptrs.listen((ptr) {
        if (!seen.add(ptr.domainName)) return;
        final f = _resolve(client, ptr.domainName);
        pending.add(f);
        f.then((d) {
          if (d != null && !out.isClosed) out.add(d);
        });
      }, onDone: () async {
        await Future.wait(pending);
        await out.close();
      }, onError: (Object e) async {
        await out.close();
      });
      yield* out.stream;
    } finally {
      try {
        client.stop();
      } catch (_) {}
      if (locked) {
        try {
          await _net.invokeMethod('multicastUnlock');
        } catch (_) {}
      }
    }
  }

  static Future<CastDevice?> _resolve(MDnsClient client, String domain) async {
    try {
      final srv = await client
          .lookup<SrvResourceRecord>(ResourceRecordQuery.service(domain),
              timeout: const Duration(seconds: 3))
          .first
          .timeout(const Duration(seconds: 4));
      final txt = await client
          .lookup<TxtResourceRecord>(ResourceRecordQuery.text(domain),
              timeout: const Duration(seconds: 2))
          .first
          .timeout(const Duration(seconds: 3))
          .then<TxtResourceRecord?>((v) => v)
          .catchError((Object _) => null);
      final ip = await client
          .lookup<IPAddressResourceRecord>(ResourceRecordQuery.addressIPv4(srv.target),
              timeout: const Duration(seconds: 3))
          .first
          .timeout(const Duration(seconds: 4));
      final fields = <String, String>{};
      for (final line in (txt?.text ?? '').split('\n')) {
        final eq = line.indexOf('=');
        if (eq > 0) fields[line.substring(0, eq)] = line.substring(eq + 1);
      }
      final name = fields['fn'] ?? domain.split('._googlecast').first;
      return CastDevice(
        id: fields['id'] ?? domain,
        name: name,
        model: fields['md'],
        host: ip.address.address,
        port: srv.port,
      );
    } catch (e) {
      debugPrint('cast: resolve $domain failed: $e');
      return null;
    }
  }

  // Dart supports SO_REUSEPORT on neither Windows nor Android (it ignores the
  // flag and logs a "Dart Socket ERROR"); SO_REUSEADDR alone shares port 5353.
  static Future<RawDatagramSocket> _bind(dynamic host, int port,
          {bool reuseAddress = true, bool reusePort = false, int ttl = 1}) =>
      RawDatagramSocket.bind(host, port,
          reuseAddress: reuseAddress,
          reusePort: (Platform.isWindows || Platform.isAndroid) ? false : reusePort,
          ttl: ttl);

  // IPv4, non-loopback interfaces only: joining the multicast group on some
  // virtual / cellular interfaces throws and would abort the whole scan.
  static Future<Iterable<NetworkInterface>> _interfaces(InternetAddressType type) async {
    final all = await NetworkInterface.list(includeLoopback: false, type: InternetAddressType.IPv4);
    final lan = all.where((i) {
      final n = i.name.toLowerCase();
      return i.addresses.isNotEmpty &&
          !n.startsWith('rmnet') &&
          !n.startsWith('ccmni') &&
          !n.startsWith('dummy') &&
          !n.contains('vethernet') &&
          !n.contains('virtualbox') &&
          !n.contains('vmware');
    }).toList();
    return lan.isEmpty ? all : lan;
  }
}
