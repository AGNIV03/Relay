import 'package:flutter/material.dart';

// Matches the web app: near-black surfaces with a modern cyan accent.
const kBg = Color(0xFF0A0A0B);
const kPanel = Color(0xFF131316);
const kPanel2 = Color(0xFF1D1D21);
const kBorder = Color(0xFF29292E);
const kAccent = Color(0xFF22D3EE); // cyan
const kAccent2 = Color(0xFF67E8F9);
const kAccentInk = Color(0xFF08272C); // dark text on accent fills
const kText = Color(0xFFF4F4F5);
const kMuted = Color(0xFFA1A1AA);

ThemeData buildTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: kBg,
    colorScheme: base.colorScheme.copyWith(
      primary: kAccent,
      onPrimary: kAccentInk,
      secondary: kAccent2,
      surface: kPanel,
      onSurface: kText,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: kBg,
      elevation: 0,
      foregroundColor: kText,
    ),
    cardColor: kPanel,
    cardTheme: const CardThemeData(color: kPanel),
    listTileTheme: const ListTileThemeData(iconColor: kMuted),
    iconTheme: const IconThemeData(color: kText),
    dividerColor: kBorder,
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: kPanel,
      indicatorColor: kAccent.withValues(alpha: 0.18),
      labelTextStyle: WidgetStatePropertyAll(
        const TextStyle(fontSize: 11, color: kMuted),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          color: states.contains(WidgetState.selected) ? kAccent : kMuted,
          size: 22,
        ),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(backgroundColor: kAccent, foregroundColor: kAccentInk),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: kPanel2,
      hintStyle: const TextStyle(color: kMuted),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: kAccent),
      ),
    ),
    sliderTheme: const SliderThemeData(
      activeTrackColor: kAccent,
      inactiveTrackColor: kPanel2,
      thumbColor: kAccent,
      trackHeight: 3,
    ),
  );
}
