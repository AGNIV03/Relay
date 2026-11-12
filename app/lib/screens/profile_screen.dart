import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/friends_panel.dart';
import 'rewind_screen.dart';
import 'settings_screen.dart';

/// Profile: the signed-in user, change password, sign out, and (on mobile)
/// friend activity. Used as the mobile Profile tab and the desktop profile page.
class ProfileScreen extends StatelessWidget {
  final bool showFriends;
  const ProfileScreen({super.key, this.showFriends = true});

  @override
  Widget build(BuildContext context) {
    final user = context.watch<AppState>().user;
    final name = user?.username ?? '';
    final initial = name.isNotEmpty ? name[0].toUpperCase() : '?';
    final role = (user?.role ?? '').toUpperCase();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Header card: avatar, name and a role chip.
        Container(
          margin: const EdgeInsets.fromLTRB(16, 20, 16, 8),
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: kPanel,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: kBorder),
          ),
          child: Row(children: [
            Container(
              width: 64,
              height: 64,
              decoration: const BoxDecoration(
                gradient: LinearGradient(colors: [kAccent, kAccent2]),
                shape: BoxShape.circle,
              ),
              child: Center(
                child: Text(initial,
                    style: const TextStyle(
                        fontSize: 28, fontWeight: FontWeight.bold, color: kAccentInk)),
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                  if (role.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                      decoration: BoxDecoration(
                        color: kAccent.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(role,
                          style: const TextStyle(
                              color: kAccent2,
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              letterSpacing: 0.5)),
                    ),
                  ],
                ],
              ),
            ),
          ]),
        ),
        // Relay Rewind: after its Home run (Dec 20 to Jan 7), last year's Rewind
        // lives here until the next one appears on Home.
        if (RewindSchedule.profileYear() case final year?)
          RewindGate(
            year: year,
            builder: (_) => _card([
              _tile(
                icon: LucideIcons.sparkles,
                label: 'Your $year Rewind',
                color: kAccent,
                onTap: () => openRewind(context, year),
              ),
            ]),
          ),
        // Account actions, grouped in a card.
        _card([
          _tile(
            icon: LucideIcons.settings,
            label: 'Change password',
            onTap: () => _changePassword(context),
          ),
          // Playback, downloads, scrobbling, privacy and "sign out everywhere".
          _tile(
            icon: Icons.tune,
            label: 'Settings',
            onTap: () => Navigator.of(context)
                .push(MaterialPageRoute(builder: (_) => const SettingsScreen())),
          ),
        ]),
        // Sign out (destructive), in its own card.
        _card([
          _tile(
            icon: LucideIcons.logOut,
            label: 'Sign out',
            color: const Color(0xFFEF4444),
            onTap: () => signOutAndReset(context),
          ),
        ]),
        if (showFriends) ...[
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 18, 20, 6),
            child: Text('Friend activity',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
          ),
          const Expanded(child: FriendsList()),
        ],
      ],
    );
  }

  Widget _card(List<Widget> children) => Container(
        margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        decoration: BoxDecoration(
          color: kPanel,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: kBorder),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(mainAxisSize: MainAxisSize.min, children: children),
      );

  Widget _tile({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
    Color? color,
  }) =>
      ListTile(
        leading: Icon(icon, size: 20, color: color),
        title: Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w500)),
        onTap: onTap,
      );


  void _changePassword(BuildContext context) {
    final current = TextEditingController();
    final next = TextEditingController();
    final api = context.read<Api>();
    showDialog(
      context: context,
      builder: (ctx) {
        String? error;
        bool busy = false;
        return StatefulBuilder(
          builder: (ctx, setLocal) => AlertDialog(
            backgroundColor: kPanel,
            title: const Text('Change password'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: current,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Current password'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: next,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'New password (min 10)'),
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(error!,
                        style: const TextStyle(color: Color(0xFFEF4444), fontSize: 13)),
                  ),
              ],
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
              TextButton(
                onPressed: busy
                    ? null
                    : () async {
                        if (next.text.length < 10) {
                          setLocal(() => error = 'New password must be at least 10 characters');
                          return;
                        }
                        setLocal(() {
                          busy = true;
                          error = null;
                        });
                        try {
                          await api.changePassword(current.text, next.text);
                          if (ctx.mounted) Navigator.pop(ctx);
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('Password changed')),
                            );
                          }
                        } catch (e) {
                          setLocal(() {
                            busy = false;
                            error = e.toString().replaceFirst('Exception: ', '');
                          });
                        }
                      },
                child: Text(busy ? 'Saving…' : 'Save'),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Sign out on this device. Stops + wipes the player BEFORE logging out,
/// otherwise audio keeps playing with no UI to stop it on the login screen.
Future<void> signOutAndReset(BuildContext context) async {
  final player = context.read<PlayerModel>();
  final appState = context.read<AppState>();
  await player.signOutReset();
  await appState.logout();
}

/// Confirm, revoke every session on the server, then sign out here too.
Future<void> signOutEverywhere(BuildContext context) async {
  final api = context.read<Api>();
  final messenger = ScaffoldMessenger.of(context);
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: kPanel,
      title: const Text('Sign out of all devices?'),
      content: const Text('Every phone, computer and browser signed in to this account '
          'will be signed out, including this one.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        TextButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: const Text('Sign out everywhere', style: TextStyle(color: Color(0xFFEF4444))),
        ),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  try {
    await api.logoutAll();
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text("Couldn't sign out everywhere: $e")));
    return;
  }
  if (context.mounted) await signOutAndReset(context);
}

/// The privacy toggles as a bottom sheet.
void showPrivacySheet(BuildContext context) {
  showModalBottomSheet(
    context: context,
    backgroundColor: kPanel,
    builder: (_) => const SafeArea(child: PrivacySettings()),
  );
}

/// Privacy toggles (bottom sheet): whether others can see what you're playing
/// (plus your history and likes), and whether they can listen along with you.
class PrivacySettings extends StatefulWidget {
  const PrivacySettings({super.key});
  @override
  State<PrivacySettings> createState() => _PrivacySettingsState();
}

class _PrivacySettingsState extends State<PrivacySettings> {
  bool? _share;
  bool? _listen;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    context.read<Api>().privacy().then((p) {
      if (mounted) setState(() {
          _share = p.shareActivity;
          _listen = p.allowListenAlong;
        });
    }).catchError((_) {
      if (mounted) setState(() => _error = "Couldn't load your privacy settings");
    });
  }

  Future<void> _set({bool? share, bool? listen}) async {
    final api = context.read<Api>();
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final p = await api.setPrivacy(shareActivity: share, allowListenAlong: listen);
      if (mounted) setState(() {
          _share = p.shareActivity;
          _listen = p.allowListenAlong;
        });
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't save. Check your connection.");
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final loaded = _share != null && _listen != null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 12, 8, 12),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text('Privacy & sharing',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
          ),
        ),
        if (!loaded && _error == null)
          const Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()),
        if (loaded) ...[
          SwitchListTile(
            value: _share!,
            onChanged: _saving ? null : (v) => _set(share: v),
            title: const Text('Share my listening activity'),
            subtitle: const Text(
                'Others on this server can see what you are playing, your recent plays and likes.'),
          ),
          SwitchListTile(
            value: _listen! && _share!,
            onChanged: _saving || !_share! ? null : (v) => _set(listen: v),
            title: const Text('Allow listen along'),
            subtitle: Text(_share!
                ? 'Others can follow along with your music in sync.'
                : 'Needs activity sharing turned on.'),
          ),
        ],
        if (_error != null)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(_error!, style: const TextStyle(color: Color(0xFFEF4444))),
          ),
      ]),
    );
  }
}
