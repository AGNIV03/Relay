# R8 rules for the release build. R8 shrinks + obfuscates the Java/Kotlin side
# only; the Dart app is AOT-compiled into libapp.so and is unaffected. Flutter's
# Gradle plugin adds its own embedding rules, and AndroidX / Media3 (ExoPlayer,
# used by just_audio) ship consumer rules, so this file only pins what those
# don't cover. Resource shrinking stays OFF (see build.gradle.kts).

# Our vendored audio_service fork (MediaBrowserService, media session, Android
# Auto browse tree, media-button receiver). It ships no consumer rules and is
# reached from the manifest, the platform media framework and Dart method
# channels by name, so keep it whole. It's a small package.
-keep class com.ryanheise.audioservice.** { *; }

# Legacy media session / browser classes are parcelled across processes to
# System UI, Android Auto and Google Assistant; keep them intact.
-keep class android.support.v4.media.** { *; }
-keep class androidx.media.** { *; }

# Our own activity (voice "play X" -> MEDIA_PLAY_FROM_SEARCH handling).
-keep class site.agniv.relay.** { *; }

# Flutter references Play Core (deferred components), which this app doesn't use.
-dontwarn com.google.android.play.core.**

# Keep line numbers so crash reports stay readable (mapping.txt deobfuscates).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
