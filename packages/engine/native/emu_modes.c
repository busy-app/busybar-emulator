// What the BUSY timer service and the BUSY program reach for outside the GUI. The emulator has no cloud, no smart
// home and no updater, so those services answer as on a bar that is not linked to an account, is not in a Matter
// fabric and has nothing to update; sound goes to the host, which plays it in the device window.
#include <furi.h>
#include <furi_hal_rtc.h>

#include <applications/system/updater/updater.h>
#include <audio/audio.h>
#include <front_display/front_display.h>
#include <matter/matter.h>
#include <mqtt/mqtt.h>

#include "host.h"

double emu_rtc_now(void);

time_t furi_hal_rtc_get_timestamp_ms(void) {
    return (time_t)emu_rtc_now();
}

// ---------------------------------------------------------------- MQTT: the cloud that syncs the timer with the phone

// Not connected: nothing is delivered and nothing goes out.
MqttSubscription* mqtt_subscribe(Mqtt* instance, MqttQos qos, const char* topic, MqttSubscriptionCallback callback, void* context) {
    (void)instance;
    (void)qos;
    (void)topic;
    (void)callback;
    (void)context;
    return NULL;
}

bool mqtt_publish(Mqtt* instance, MqttQos qos, const char* topic, const void* data, size_t data_size) {
    (void)instance;
    (void)qos;
    (void)topic;
    (void)data;
    (void)data_size;
    return false;
}

const void* mqtt_message_get_data(const MqttMessage* message, size_t* data_size) {
    (void)message;
    if(data_size) *data_size = 0;
    return NULL;
}

// ---------------------------------------------------------------- Matter: the smart-home switch the timer can flip

// The switch exists on a bar that is in no smart home too, and is on (the stock bar on release 1.3.1, out of the
// box, answers GET /api/smart_home/switch with {"state":true}). It is kept and reported, and that is all: on a bar the
// BUSY timer follows the switch (on starts the timer's program, off stops it) through the queues of two services,
// which the emulator's single thread does not untangle, so here a change of the switch is not told to the timer.
static FuriState* emu_matter_switch;
static MatterSwitchState* emu_matter_switch_value;

// A state object checks that it is locked when it is released: with one thread, it always is.
FuriThreadId furi_mutex_get_owner(FuriMutex* instance) {
    (void)instance;
    return furi_thread_get_current_id();
}

FuriState* matter_get_switch_state(Matter* instance) {
    (void)instance;
    if(!emu_matter_switch) {
        emu_matter_switch = furi_state_alloc(sizeof(MatterSwitchState));
        MatterSwitchState on = MatterSwitchStateOn;
        furi_state_set(emu_matter_switch, &on);
        // The state's own storage, to change it without telling the subscribers.
        emu_matter_switch_value = furi_state_acquire(emu_matter_switch);
        furi_state_release(emu_matter_switch);
    }
    return emu_matter_switch;
}

MatterStatus matter_set_switch_state(Matter* instance, MatterSwitchState switch_state) {
    matter_get_switch_state(instance);
    *emu_matter_switch_value = switch_state;
    return MatterStatusOk;
}

MatterStatus matter_set_switch_startup_mode(Matter* instance, MatterSwitchStartupMode mode) {
    (void)instance;
    (void)mode;
    return MatterStatusOk;
}

// ---------------------------------------------------------------- updater, front display, speaker

void updater_pause_autoupdates(Updater* instance) {
    (void)instance;
}

void updater_resume_autoupdates(Updater* instance) {
    (void)instance;
}

void front_display_set_blanked(FrontDisplaySrv* instance, bool is_blanked) {
    (void)instance;
    (void)is_blanked;
}

bool audio_play_file(Audio* instance, const char* file_name) {
    (void)instance;
    return host_audio_play(file_name);
}
