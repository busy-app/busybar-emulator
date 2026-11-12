// Calls from the wasm side into the JS host (implemented with EM_JS in host.c).
// Everything the device does outside the JS runtime — clock, files, network, timers, screen — lives in the host.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void host_log(int level, const char* tag, const char* message);
void host_console(int severity, const char* text, size_t size, int separator);
double host_now(void);
int32_t host_tza(double unix_ms);
void host_fatal(int code);
// The module stops here, in the middle of a call from the host: the bar restarts or resets (stuck = false), or a
// firmware thread hangs in a wait (stuck = true). The host's function does not return: it throws through the module to
// the host's own call, and the host uses the module no more.
void host_halt(bool stuck);
void host_app_done(void);
// The emulator's watchdog: whether the host's call into the runtime has run longer than the host allows a slice
// (packages/server/runtime.mjs). JS runs on the host's only thread, so a slice that does not return holds everything.
bool host_slice_overdue(void);

// Files, by absolute device path (/ext/...). Returns a malloc'ed buffer or NULL.
uint8_t* host_file_read(const char* path, uint32_t* out_size);
bool host_file_write(const char* path, const void* data, size_t size);
// A directory's entries as malloc'ed text, a "d name" or "f name" line each; NULL if there is no such directory.
char* host_dir_list(const char* path);
// Removes a file or a directory with everything in it.
bool host_remove(const char* path);

// Timers: the host calls emu_timer_fire(timer) after `ms`; periodic timers keep firing until stopped.
void host_timer_start(void* timer, uint32_t ms, bool periodic);
void host_timer_stop(void* timer);

// Network: the host performs the request and reports back through emu_fetch_* exports.
// device_key: the app asked for the device's own TLS client certificate (fetch's dispatcher.connect.useDeviceKey).
void host_fetch_start(void* fetch, const char* url, const char* method, const char* headers_json, const void* body, size_t body_size, int device_key);
void host_fetch_stop(void* fetch);

// Screen: the reply to the /api/display request on connection `id` is ready (see emu_screen.c).
void host_reply_ready(unsigned long id);

// Screen: the JS app launcher runs an app (in the runtime module) or aborts the running one (see emu_system.c).
void host_app_start(uint32_t run_id, const char* app_id, const char* path, size_t heap_size);
void host_app_abort(void);
// The speaker: plays a file of the device (raw 16-bit mono PCM, 44100 Hz) as the audio service would.
bool host_audio_play(const char* path);
// A setting changed on the device itself (the settings programs): "volume" 0..100, "brightness" auto or 0..100,
// "timezone" a zone's name, "wifi" 0, "power" off or reboot, "factory_reset". The host keeps its own state in step.
void host_setting_changed(const char* name, const char* value);
// The status lights (see emu_screen.c): preset is the firmware's StatusLightsPreset, r g b its color, override the
// user brightness 0..100 a program holds the lights at or -1, started whether the firmware started the preset now
// (status_lights_run_preset) or only the override changed.
void host_lights(int preset, int r, int g, int b, int override, bool started);
// The name of the bar's time zone, as the firmware's zone list has it; malloc'ed.
char* host_timezone(void);
// The address the emulated bar answers on, "http://127.0.0.1:8640" or another port; malloc'ed, NULL when the host has
// none. The firmware's texts that send an author to the bar's USB address (10.0.4.20) show it instead (patches.mjs).
// Screen module only: defined in emu_system.c.
char* host_bar_address(void);
