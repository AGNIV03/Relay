#include "smtc_plugin.h"

#include <flutter/standard_method_codec.h>
#include <systemmediatransportcontrolsinterop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Media.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Streams.h>

#include <atomic>
#include <chrono>
#include <string>

namespace wf = winrt::Windows::Foundation;
namespace wm = winrt::Windows::Media;
namespace ws = winrt::Windows::Storage;
namespace wss = winrt::Windows::Storage::Streams;

namespace {

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int len = ::MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                                  nullptr, 0);
  std::wstring out(len, L'\0');
  ::MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(),
                        len);
  return out;
}

std::string GetString(const flutter::EncodableMap& m, const char* key) {
  auto it = m.find(flutter::EncodableValue(key));
  if (it == m.end()) return std::string();
  if (const auto* s = std::get_if<std::string>(&it->second)) return *s;
  return std::string();
}

int64_t GetInt(const flutter::EncodableMap& m, const char* key) {
  auto it = m.find(flutter::EncodableValue(key));
  if (it == m.end()) return 0;
  if (const auto* i = std::get_if<int32_t>(&it->second)) return *i;
  if (const auto* l = std::get_if<int64_t>(&it->second)) return *l;
  return 0;
}

bool GetBool(const flutter::EncodableMap& m, const char* key) {
  auto it = m.find(flutter::EncodableValue(key));
  if (it == m.end()) return false;
  if (const auto* b = std::get_if<bool>(&it->second)) return *b;
  return false;
}

}  // namespace

struct SmtcPlugin::Impl {
  wm::SystemMediaTransportControls smtc{nullptr};
  winrt::event_token button_token{};
  winrt::event_token seek_token{};
  // Bumped on every metadata update so a slow async thumbnail load for an
  // older track never overwrites the current one.
  std::shared_ptr<std::atomic<int>> generation = std::make_shared<std::atomic<int>>(0);
};

SmtcPlugin::SmtcPlugin(flutter::BinaryMessenger* messenger, HWND hwnd)
    : hwnd_(hwnd), impl_(std::make_unique<Impl>()) {
  channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      messenger, "relay/smtc", &flutter::StandardMethodCodec::GetInstance());
  channel_->SetMethodCallHandler([this](const auto& call, auto result) {
    HandleMethodCall(call, std::move(result));
  });
}

SmtcPlugin::~SmtcPlugin() {
  channel_->SetMethodCallHandler(nullptr);
  if (impl_->smtc) {
    try {
      impl_->smtc.ButtonPressed(impl_->button_token);
      impl_->smtc.PlaybackPositionChangeRequested(impl_->seek_token);
      impl_->smtc.DisplayUpdater().ClearAll();
      impl_->smtc.IsEnabled(false);
    } catch (...) {
    }
  }
}

void SmtcPlugin::HandleWindowMessage(WPARAM wparam, LPARAM lparam) {
  if (wparam == 0) {
    const char* name = nullptr;
    switch (static_cast<wm::SystemMediaTransportControlsButton>(lparam)) {
      case wm::SystemMediaTransportControlsButton::Play:
        name = "play";
        break;
      case wm::SystemMediaTransportControlsButton::Pause:
        name = "pause";
        break;
      case wm::SystemMediaTransportControlsButton::Next:
        name = "next";
        break;
      case wm::SystemMediaTransportControlsButton::Previous:
        name = "previous";
        break;
      case wm::SystemMediaTransportControlsButton::Stop:
        name = "stop";
        break;
      default:
        return;
    }
    channel_->InvokeMethod("button",
                           std::make_unique<flutter::EncodableValue>(std::string(name)));
  } else if (wparam == 1) {
    channel_->InvokeMethod(
        "seek", std::make_unique<flutter::EncodableValue>(static_cast<int64_t>(lparam)));
  }
}

void SmtcPlugin::HandleMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
  try {
    if (!impl_->smtc) {
      auto interop = winrt::get_activation_factory<wm::SystemMediaTransportControls,
                                                   ISystemMediaTransportControlsInterop>();
      wm::SystemMediaTransportControls smtc{nullptr};
      winrt::check_hresult(interop->GetForWindow(
          hwnd_, winrt::guid_of<wm::SystemMediaTransportControls>(), winrt::put_abi(smtc)));
      smtc.IsPlayEnabled(true);
      smtc.IsPauseEnabled(true);
      smtc.IsNextEnabled(true);
      smtc.IsPreviousEnabled(true);
      smtc.IsStopEnabled(true);
      HWND hwnd = hwnd_;
      impl_->button_token = smtc.ButtonPressed(
          [hwnd](const auto&, const wm::SystemMediaTransportControlsButtonPressedEventArgs& e) {
            ::PostMessage(hwnd, SmtcPlugin::kMessage, 0, static_cast<LPARAM>(e.Button()));
          });
      impl_->seek_token = smtc.PlaybackPositionChangeRequested(
          [hwnd](const auto&, const wm::PlaybackPositionChangeRequestedEventArgs& e) {
            auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                          e.RequestedPlaybackPosition())
                          .count();
            ::PostMessage(hwnd, SmtcPlugin::kMessage, 1, static_cast<LPARAM>(ms));
          });
      impl_->smtc = smtc;
    }
    auto smtc = impl_->smtc;
    const std::string& method = call.method_name();

    if (method == "metadata" && args) {
      smtc.IsEnabled(true);
      auto updater = smtc.DisplayUpdater();
      updater.Type(wm::MediaPlaybackType::Music);
      auto music = updater.MusicProperties();
      music.Title(winrt::hstring(Utf8ToWide(GetString(*args, "title"))));
      music.Artist(winrt::hstring(Utf8ToWide(GetString(*args, "artist"))));
      music.AlbumTitle(winrt::hstring(Utf8ToWide(GetString(*args, "album"))));
      const int gen = ++(*impl_->generation);
      const std::string art_path = GetString(*args, "artPath");
      const std::string art_url = GetString(*args, "artUrl");
      if (!art_url.empty() && art_path.empty()) {
        updater.Thumbnail(wss::RandomAccessStreamReference::CreateFromUri(
            wf::Uri(winrt::hstring(Utf8ToWide(art_url)))));
      } else if (art_path.empty()) {
        updater.Thumbnail(nullptr);
      }
      updater.Update();
      if (!art_path.empty()) {
        // A downloaded track's cover on disk (works offline): load it async.
        auto generation = impl_->generation;
        auto op = ws::StorageFile::GetFileFromPathAsync(winrt::hstring(Utf8ToWide(art_path)));
        op.Completed([smtc, gen, generation](const auto& async, wf::AsyncStatus status) {
          if (status != wf::AsyncStatus::Completed || generation->load() != gen) return;
          try {
            auto u = smtc.DisplayUpdater();
            u.Thumbnail(wss::RandomAccessStreamReference::CreateFromFile(async.GetResults()));
            u.Update();
          } catch (...) {
          }
        });
      }
    } else if (method == "state" && args) {
      smtc.IsEnabled(true);
      smtc.PlaybackStatus(GetBool(*args, "playing") ? wm::MediaPlaybackStatus::Playing
                                                   : wm::MediaPlaybackStatus::Paused);
    } else if (method == "timeline" && args) {
      const auto pos = std::chrono::milliseconds(GetInt(*args, "positionMs"));
      const auto dur = std::chrono::milliseconds(GetInt(*args, "durationMs"));
      wm::SystemMediaTransportControlsTimelineProperties tl;
      tl.StartTime(wf::TimeSpan(0));
      tl.MinSeekTime(wf::TimeSpan(0));
      tl.Position(std::chrono::duration_cast<wf::TimeSpan>(pos));
      tl.MaxSeekTime(std::chrono::duration_cast<wf::TimeSpan>(dur));
      tl.EndTime(std::chrono::duration_cast<wf::TimeSpan>(dur));
      smtc.UpdateTimelineProperties(tl);
    } else if (method == "clear") {
      ++(*impl_->generation);
      smtc.DisplayUpdater().ClearAll();
      smtc.DisplayUpdater().Update();
      smtc.PlaybackStatus(wm::MediaPlaybackStatus::Closed);
      smtc.IsEnabled(false);
    } else {
      result->NotImplemented();
      return;
    }
    result->Success();
  } catch (const winrt::hresult_error& e) {
    result->Error("smtc", winrt::to_string(e.message()));
  } catch (...) {
    result->Error("smtc", "SMTC call failed");
  }
}
