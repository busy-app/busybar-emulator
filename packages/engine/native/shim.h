// Shared between the emulator's shims (not part of the firmware's API).
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct FuriThread FuriThread;
typedef struct FuriMessageQueue FuriMessageQueue;
typedef struct FuriEventLoop FuriEventLoop;

typedef struct {
    FuriMessageQueue* queue;
    void* data;
} EmuHeldMessage;

void emu_furi_crash(const char* message);

// The thread whose callback is running right now (messages it posts are being held), or NULL.
FuriThread* emu_capture_thread(void);
// Keep the thread's held messages until emu_thread_release().
void emu_thread_wait(FuriThread* thread);
// Deliver the held messages; ok=false drops all but the last one ("done" was never posted on the bar).
void emu_thread_release(FuriThread* thread, bool ok);

// Drains the event loops: runs subscribed callbacks while their objects are ready, then finishes stopped apps. For the
// end of a call from the host.
void emu_pump(void);
// A thread sleeps or waits `ticks` for `what`: the other threads get a turn, no time passes (furi_shim.c, "waits").
void emu_wait_turn(const char* what, uint32_t ticks);
// What a sleep is for besides the other threads' events; the screen module sets it (the GUI draws what has changed).
extern void (*emu_sleep_hook)(void);
// Whether a callback of the loop is running now, at any depth: its thread is in the middle of something.
bool emu_loop_in_callback(const FuriEventLoop* loop);
// The bar goes down here (a restart, or a thread stuck in a wait): the call from the host ends at once and the host
// is told; it does not use this module again. Never returns.
void emu_halt(bool stuck) __attribute__((noreturn));

// furi_event_loop_run(loop) and then then(context) once the loop is stopped: an app's main function (patched).
void emu_event_loop_run_then(FuriEventLoop* instance, void (*then)(void* context), void* context);
// Whether the thread runs a loop that has not been stopped yet.
bool emu_thread_is_running(FuriThread* thread);
// Whose /data/... folder storage resolves paths to (storage_shim.c).
extern const char* (*emu_app_data_owner)(void);
// Called when an app's thread is over (its loop stopped and it cleaned up).
extern void (*emu_thread_exit_hook)(FuriThread* thread);

// A refresh of display 0 (front) or 1 (back) sent a frame: the GUI spends the time that takes on a bar (furi_shim.c).
void emu_gui_drew(int display);
// The GUI's event loop: its ticks wait while it draws (furi_shim.c).
void emu_gui_set_loop(FuriEventLoop* loop);
// Whether drawing takes the GUI time (bar speed), and whether the clock, read on the next tick, would show a later
// time than the tick's: the GUI is still drawing then, or something has read the clock that late already.
bool emu_gui_draws_take_time(void);
bool emu_gui_behind(void);
