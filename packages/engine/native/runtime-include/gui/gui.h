// Emulator stand-in for applications/services/gui/gui.h: just the input-callback part js_input.c uses.
// Signatures match the firmware; gui_shim.c forwards input from the host to the registered callback.
#pragma once

#include <input/input.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RECORD_GUI "gui"

typedef enum {
    GuiLayerIdSystem = 0,
} GuiLayerId;

typedef struct Gui Gui;
typedef struct GuiLayer GuiLayer;

typedef bool (*GuiInputCallback)(const InputEvent* event, void* context);

GuiLayer* gui_get_layer(Gui* instance, GuiLayerId layer_id);
void gui_layer_add_input_callback(GuiLayer* layer, GuiInputCallback callback, void* context);
void gui_layer_remove_input_callback(GuiLayer* layer, GuiInputCallback callback);
void gui_lock(Gui* instance);
void gui_unlock(Gui* instance);

#define with_gui(gui, code) \
    {                       \
        gui_lock(gui);      \
        {code};             \
        gui_unlock(gui);    \
    }

#ifdef __cplusplus
}
#endif
