import 'package:flutter/material.dart';

const kBg = Color(0xFF0A0A0F);
const kPanel = Color(0xFF14141C);
const kPanel2 = Color(0xFF1C1C28);
const kAccent = Color(0xFF7C5CFF);
const kAccent2 = Color(0xFFA78BFA);
const kMuted = Color(0xFF9A9AB0);

ThemeData buildTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: kBg,
    colorScheme: base.colorScheme.copyWith(
      primary: kAccent,
      secondary: kAccent2,
      surface: kPanel,
    ),
    appBarTheme: const AppBarTheme(backgroundColor: kBg, elevation: 0),
    cardColor: kPanel,
    cardTheme: const CardThemeData(color: kPanel),
    listTileTheme: const ListTileThemeData(iconColor: kMuted),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: kPanel,
      indicatorColor: kAccent.withValues(alpha: 0.25),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: kPanel2,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide.none,
      ),
    ),
  );
}
