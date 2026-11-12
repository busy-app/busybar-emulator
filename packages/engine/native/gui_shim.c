// The GUI input layer for the emulator: js_input.c registers its callback here, the host feeds key events in.
#include <gui/gui.h>

#include <emscripten.h>
#include <stddef.h>

#include "shim.h"

struct GuiLayer {
    GuiInputCallback callback;
    void* context;
};

static struct GuiLayer emu_system_layer;
static uint32_t emu_sequence = 0;

GuiLayer* gui_get_layer(Gui* instance, GuiLayerId layer_id) {
    (void)instance;
    (void)layer_id;
    return &emu_system_layer;
}

void gui_layer_add_input_callback(GuiLayer* layer, GuiInputCallback callback, void* context) {
    layer->callback = callback;
    layer->context = context;
}

void gui_layer_remove_input_callback(GuiLayer* layer, GuiInputCallback callback) {
    if(layer->callback == callback) {
        layer->callback = NULL;
        layer->context = NULL;
    }
}

void gui_lock(Gui* instance) {
    (void)instance;
}

void gui_unlock(Gui* instance) {
    (void)instance;
}

// key: InputKey, type: InputType (firmware values). Returns 1 if a listener took the event.
EMSCRIPTEN_KEEPALIVE int emu_input(int key, int type) {
    int taken = 0;
    if(emu_system_layer.callback) {
        InputEvent event = {
            .key = (InputKey)key,
            .type = (InputType)type,
            .sequence_source = 0,
            .sequence_number = ++emu_sequence,
        };
        taken = emu_system_layer.callback(&event, emu_system_layer.context) ? 1 : 0;
    }
    emu_pump();
    return taken;
}
