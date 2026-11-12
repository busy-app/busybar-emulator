// Emulator stand-in for targets/f21/furi_hal/furi_hal_resources.h: only the key enum that input.h needs.
// The order must match the firmware, the values travel between the host and the firmware's js_input.c.
#pragma once

typedef enum {
    InputKeyUp,
    InputKeyDown,
    InputKeyRight,
    InputKeyLeft,
    InputKeyOk,
    InputKeyBack,
    InputKeyStart,
    InputKeyBusy,
    InputKeyCustom,
    InputKeyOff,
    InputKeyApps,
    InputKeySettings,
    InputKeyMAX,
} InputKey;
