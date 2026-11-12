#ifndef RUNNER_SMTC_PLUGIN_H_
#define RUNNER_SMTC_PLUGIN_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <windows.h>

#include <memory>

// Windows System Media Transport Controls (the media flyout / lock screen /
// hardware media keys) for the desktop app. libmpv (media_kit) doesn't register
// an SMTC session, so without this the keyboard media keys only work while the
// window is focused and Windows shows no "now playing" overlay.
//
// Dart side: lib/smtc.dart, channel "relay/smtc".
//   Dart -> native: metadata {title, artist, album, artUrl?, artPath?},
//                   state {playing}, timeline {positionMs, durationMs}, clear
//   native -> Dart: button ("play" | "pause" | "next" | "previous" | "stop"),
//                   seek (positionMs)
// SMTC events arrive on a background thread; they're posted to the window as
// kMessage and forwarded to Dart from the platform thread.
class SmtcPlugin {
 public:
  static constexpr UINT kMessage = WM_APP + 0x51;

  SmtcPlugin(flutter::BinaryMessenger* messenger, HWND hwnd);
  ~SmtcPlugin();

  // Call from the window procedure for kMessage.
  void HandleWindowMessage(WPARAM wparam, LPARAM lparam);

 private:
  struct Impl;
  void HandleMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  HWND hwnd_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  std::unique_ptr<Impl> impl_;
};

#endif  // RUNNER_SMTC_PLUGIN_H_
