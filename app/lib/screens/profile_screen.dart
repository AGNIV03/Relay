import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../player.dart';
import '../theme.dart';
import '../widgets/friends_panel.dart';
import 'rewind_screen.dart';

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
        // Relay Rewind — year in review (available any time from here).
        _card([
          _tile(
            icon: LucideIcons.sparkles,
            label: 'Your ${DateTime.now().year} Rewind',
            color: kAccent,
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => RewindScreen(year: DateTime.now().year)),
            ),
          ),
        ]),
        // Account actions, grouped in a card.
        _card([
          _tile(
            icon: LucideIcons.settings,
            label: 'Change password',
            onTap: () => _changePassword(context),
          ),
        ]),
        // Sign out (destructive), in its own card.
        _card([
          _tile(
            icon: LucideIcons.logOut,
            label: 'Sign out',
            color: const Color(0xFFEF4444),
            onTap: () async {
              // Stop + wipe the player BEFORE logging out, otherwise audio keeps
              // playing with no UI to stop it once we're on the login screen.
              final player = context.read<PlayerModel>();
              final appState = context.read<AppState>();
              await player.signOutReset();
              await appState.logout();
            },
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
                  decoration: const InputDecoration(labelText: 'New password (min 6)'),
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
                        if (next.text.length < 6) {
                          setLocal(() => error = 'New password must be at least 6 characters');
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
