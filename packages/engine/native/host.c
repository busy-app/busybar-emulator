#include "host.h"

#include <emscripten.h>
#include <stdlib.h>

EM_JS(void, host_log, (int level, const char* tag, const char* message), {
    Module.host.log(level, UTF8ToString(tag), UTF8ToString(message));
});

EM_JS(void, host_console, (int severity, const char* text, size_t size, int separator), {
    Module.host.console(severity, UTF8ToString(text, size), separator);
});

EM_JS(double, host_now, (void), { return Module.host.now(); });
EM_JS(int32_t, host_tza, (double unix_ms), { return Module.host.tza(unix_ms); });
EM_JS(void, host_fatal, (int code), { Module.host.fatal(code); });
EM_JS(void, host_halt, (bool stuck), {
    if (Module.host.halt) Module.host.halt(!!stuck);
    throw new Error("The module halted");
});
EM_JS(void, host_app_done, (void), { Module.host.appDone(); });
EM_JS(bool, host_slice_overdue, (void), { return Module.host.sliceOverdue && Module.host.sliceOverdue() ? 1 : 0; });

EM_JS(uint8_t*, host_file_read, (const char* path, uint32_t* out_size), {
    const bytes = Module.host.fileRead(UTF8ToString(path));
    if (!bytes) return 0;
    const ptr = _malloc(Math.max(bytes.length, 1));
    HEAPU8.set(bytes, ptr);
    HEAPU32[out_size >> 2] = bytes.length;
    return ptr;
});

EM_JS(bool, host_file_write, (const char* path, const void* data, size_t size), {
    return Module.host.fileWrite(UTF8ToString(path), HEAPU8.slice(data, data + size)) ? 1 : 0;
});

EM_JS(char*, host_dir_list, (const char* path), {
    const entries = Module.host.dirList(UTF8ToString(path));
    if (!entries) return 0;
    return stringToNewUTF8(entries.map((e) => (e.dir ? "d " : "f ") + e.name).join("\n"));
});

EM_JS(bool, host_remove, (const char* path), { return Module.host.remove(UTF8ToString(path)) ? 1 : 0; });

EM_JS(void, host_timer_start, (void* timer, uint32_t ms, bool periodic), {
    Module.host.timerStart(timer, ms, !!periodic);
});

EM_JS(void, host_timer_stop, (void* timer), { Module.host.timerStop(timer); });

EM_JS(void, host_fetch_start, (void* fetch, const char* url, const char* method, const char* headers_json, const void* body, size_t body_size, int device_key), {
    Module.host.fetchStart(
        fetch,
        UTF8ToString(url),
        UTF8ToString(method),
        JSON.parse(UTF8ToString(headers_json)),
        body ? HEAPU8.slice(body, body + body_size) : null,
        device_key !== 0);
});

EM_JS(void, host_fetch_stop, (void* fetch), { Module.host.fetchStop(fetch); });

EM_JS(void, host_reply_ready, (unsigned long id), { Module.host.replyReady(id); });

EM_JS(void, host_app_start, (uint32_t run_id, const char* app_id, const char* path, size_t heap_size), {
    Module.host.appStart(run_id, UTF8ToString(app_id), UTF8ToString(path), heap_size);
});

EM_JS(void, host_app_abort, (void), { Module.host.appAbort(); });

EM_JS(void, host_setting_changed, (const char* name, const char* value), {
    if (Module.host.settingChanged) Module.host.settingChanged(UTF8ToString(name), UTF8ToString(value));
});

EM_JS(void, host_lights, (int preset, int r, int g, int b, int override, bool started), {
    if (Module.host.lights) Module.host.lights(preset, r, g, b, override, !!started);
});

EM_JS(char*, host_timezone, (void), { return stringToNewUTF8(Module.host.timezone ? Module.host.timezone() : "Universal"); });

EM_JS(bool, host_audio_play, (const char* path), { return Module.host.audioPlay ? Module.host.audioPlay(UTF8ToString(path)) : false; });
