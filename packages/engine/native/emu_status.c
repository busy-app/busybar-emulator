// The services the firmware's status bar (applications/services/status_bar) shows on the back display: power, audio,
// Wi-Fi and BLE. The status bar runs unchanged; these stand-ins hold the state the host gives with emu_screen_status()
// and tell it about changes the way the services do: Wi-Fi through its FuriState, BLE, power and audio through their
// pubsubs.
//
// Until the host says otherwise the state is what the bar showed in every golden frame: Wi-Fi
// connected, BLE not shown, sound on, USB connected, battery 100% and not charging.
#include <furi.h>

#include <audio/audio.h>
#include <ble/ble.h>
#include <power/power_service/power.h>
#include <wifi/wifi.h>

#include <emscripten.h>
#include <string.h>

#include "host.h"
#include "shim.h"

typedef enum {
    EmuBatteryStateNormal,
    EmuBatteryStateLow,
    EmuBatteryStateCritical,
} EmuBatteryState;

struct Power {
    FuriPubSub* pubsub;
    bool usb_connected;
    bool charging;
    uint8_t charge;
    EmuBatteryState battery_state;
};

struct Audio {
    FuriPubSub* pubsub;
    float volume;
};

struct Wifi {
    FuriState* state;
};

struct Ble {
    FuriPubSub* pubsub;
    BleServiceStatus status;
};

static struct Power emu_power;
static struct Audio emu_audio;
static struct Wifi emu_wifi;
static struct Ble emu_ble;

// ---------------------------------------------------------------- power

FuriPubSub* power_get_pubsub(Power* power) {
    return power->pubsub;
}

bool power_is_usb_connected(Power* power) {
    return power->usb_connected;
}

void power_get_info(Power* power, PowerInfo* info) {
    memset(info, 0, sizeof(PowerInfo));
    info->is_charging = power->charging;
    info->is_full_charged = power->charge >= 100;
    info->charge_enabled = true;
    info->charge = power->charge;
}

bool power_is_battery_ready(Power* power) {
    (void)power;
    return true;
}

// Power off in the system settings: the host is told and turns the emulated bar off once this call is over.
bool power_off(Power* power) {
    (void)power;
    host_setting_changed("power", "off");
    return true;
}

// A restart (the supervisor, the system settings): the host is told, and the firmware stops right here, as on a bar,
// where the processor resets inside this call. The restart program of the system settings counts on that: after the
// call it spins in an empty loop.
void power_reboot(Power* power, PowerRebootMode mode) {
    (void)power;
    (void)mode;
    host_setting_changed("power", "reboot");
    emu_halt(false);
}

float power_get_temperature_battery_celsius(float temperature_battery) {
    return temperature_battery;
}

// ---------------------------------------------------------------- audio

FuriPubSub* audio_get_pubsub(Audio* instance) {
    return instance->pubsub;
}

float audio_get_volume(Audio* instance) {
    return instance->volume;
}

// The sound settings set the volume; the host's volume (GET /api/audio/volume) follows.
void audio_set_volume(Audio* instance, float volume) {
    instance->volume = volume;
    AudioEvent event = {.type = AudioEventVolumeUpdate};
    furi_pubsub_publish(instance->pubsub, &event);
    char value[8];
    snprintf(value, sizeof(value), "%d", (int)(volume * 100.0f + 0.5f));
    host_setting_changed("volume", value);
}

// ---------------------------------------------------------------- Wi-Fi and BLE

FuriState* wifi_get_state(Wifi* instance) {
    return instance->state;
}

// The emulated air: two access points. "Emulator" is the one the bar is on at start; its password is anything of
// eight characters or more, as WPA takes them. The bar remembers the last network it was on: turning Wi-Fi back on
// in the device window joins it again.
typedef struct {
    const char* ssid;
    WifiSecurityMode security_mode;
    uint8_t rssi;
    uint8_t bssid[HW_ADDRESS_LEN];
    uint16_t channel;
} EmuAccessPoint;

static const EmuAccessPoint emu_access_points[] = {
    {.ssid = "Emulator", .security_mode = WifiSecurityModeWpa2, .rssi = 40, .bssid = {0x02, 0x00, 0x00, 0x00, 0x00, 0x10}, .channel = 6},
    {.ssid = "Emulator Open", .security_mode = WifiSecurityModeOpen, .rssi = 62, .bssid = {0x02, 0x00, 0x00, 0x00, 0x00, 0x11}, .channel = 11},
};

static const EmuAccessPoint* emu_wifi_ap = &emu_access_points[0];
static WifiIpConfig emu_wifi_ip = {
    .mgmt = WifiIpManagementDynamic,
    .type = WifiIpTypeV4,
    .ip4 = {.address = {.bytes = {192, 168, 1, 100}}, .gateway = {.bytes = {192, 168, 1, 1}}, .mask = {.bytes = {255, 255, 255, 0}}},
};

static WifiState emu_wifi_state_now(Wifi* instance) {
    WifiInfo info;
    furi_state_get(instance->state, &info);
    return info.state;
}

// The state with everything a connected bar reports of its network.
static void emu_wifi_set_state(Wifi* instance, WifiState state) {
    WifiInfo info = {.state = state};
    if(state == WifiStateConnected) {
        strlcpy(info.ssid, emu_wifi_ap->ssid, sizeof(info.ssid));
        memcpy(info.bssid, emu_wifi_ap->bssid, sizeof(info.bssid));
        info.rssi = -(int32_t)emu_wifi_ap->rssi;
        info.channel = emu_wifi_ap->channel;
        info.security_mode = emu_wifi_ap->security_mode;
        info.ip_config = emu_wifi_ip;
    }
    furi_state_set(instance->state, &info);
}

WifiStatus wifi_get_info(Wifi* instance, WifiInfo* info) {
    furi_state_get(instance->state, info);
    return WifiStatusOk;
}

// wifi_state.c: a scan is possible only when disconnected.
WifiStatus wifi_scan(Wifi* instance, WifiScanResult* results, uint8_t* result_count, uint8_t max_result_count) {
    if(emu_wifi_state_now(instance) != WifiStateDisconnected) return WifiStatusScanNotPossible;
    uint8_t count = 0;
    for(size_t i = 0; i < COUNT_OF(emu_access_points) && count < max_result_count; i++) {
        memset(&results[count], 0, sizeof(WifiScanResult));
        strlcpy(results[count].ssid, emu_access_points[i].ssid, sizeof(results[count].ssid));
        results[count].security_mode = emu_access_points[i].security_mode;
        results[count].rssi = emu_access_points[i].rssi;
        count++;
    }
    *result_count = count;
    return WifiStatusOk;
}

WifiStatus wifi_connect(Wifi* instance, const WifiCredentials* credentials, const WifiIpConfig* ip_config) {
    if(emu_wifi_state_now(instance) != WifiStateDisconnected) return WifiStatusAlreadyConnected;
    const EmuAccessPoint* ap = NULL;
    for(size_t i = 0; i < COUNT_OF(emu_access_points); i++) {
        if(strcmp(credentials->ssid, emu_access_points[i].ssid) == 0) ap = &emu_access_points[i];
    }
    if(!ap) return WifiStatusAccessPointNotFound;
    // What the radio says of a passphrase that cannot be one.
    if(ap->security_mode != WifiSecurityModeOpen && strlen(credentials->passphrase) < 8) return WifiStatusAuthenticationFailed;
    emu_wifi_ap = ap;
    if(ip_config->mgmt == WifiIpManagementStatic) {
        emu_wifi_ip = *ip_config;
    } else {
        emu_wifi_ip = (WifiIpConfig){
            .mgmt = WifiIpManagementDynamic,
            .type = WifiIpTypeV4,
            .ip4 = {.address = {.bytes = {192, 168, 1, 100}}, .gateway = {.bytes = {192, 168, 1, 1}}, .mask = {.bytes = {255, 255, 255, 0}}},
        };
    }
    emu_wifi_set_state(instance, WifiStateConnected);
    host_setting_changed("wifi", "1");
    return WifiStatusOk;
}

// The host's Wi-Fi switch follows: without Wi-Fi the apps' requests to the network fail.
WifiStatus wifi_disconnect(Wifi* instance) {
    if(emu_wifi_state_now(instance) != WifiStateConnected) return WifiStatusAlreadyDisconnected;
    emu_wifi_set_state(instance, WifiStateDisconnected);
    host_setting_changed("wifi", "0");
    return WifiStatusOk;
}

// Forgetting is possible only when disconnected; the Wi-Fi settings program disconnects first if it has to.
WifiStatus wifi_forget(Wifi* instance) {
    if(emu_wifi_state_now(instance) == WifiStateConnected) wifi_disconnect(instance);
    emu_wifi_ap = &emu_access_points[0];
    return WifiStatusOk;
}

// Bluetooth: the emulator has no radio; turning it on and off is remembered and shown, nothing connects.
bool ble_start(Ble* ble) {
    ble->status = BleServiceStatusAdvertising;
    BleState state = {.status = ble->status};
    furi_pubsub_publish(ble->pubsub, &state);
    host_setting_changed("ble", "1");
    return true;
}

bool ble_stop(Ble* ble) {
    ble->status = BleServiceStatusReady;
    BleState state = {.status = ble->status};
    furi_pubsub_publish(ble->pubsub, &state);
    host_setting_changed("ble", "0");
    return true;
}

bool ble_forget(Ble* ble) {
    (void)ble;
    return true;
}

FuriPubSub* ble_get_pubsub(Ble* ble) {
    return ble->pubsub;
}

bool ble_get_state(Ble* ble, BleState* const output) {
    memset(output, 0, sizeof(BleState));
    output->status = ble->status;
    return true;
}

// ---------------------------------------------------------------- the host's state

static void emu_status_publish_power(PowerEventType type) {
    PowerEvent event = {.type = type};
    furi_pubsub_publish(emu_power.pubsub, &event);
}

// power.c's power_process_battery_state(): low under 15 % and critical under 5 %, each with 3 % of hysteresis; a
// charging battery is normal. The supervisor takes "critical" as half a minute left before it powers the bar off.
static void emu_status_battery_state(void) {
    EmuBatteryState state = emu_power.battery_state;
    const int charge = emu_power.charge;
    const int low = POWER_PERCENT_LOW;
    const int critical = POWER_PERCENT_CRITICAL;
    const int hysteresis = POWER_PERCENT_HYSTERESIS;
    // On USB the battery charges or is full.
    if(emu_power.charging || emu_power.usb_connected) {
        state = EmuBatteryStateNormal;
    } else if(state == EmuBatteryStateNormal) {
        if(charge < critical - hysteresis) state = EmuBatteryStateCritical;
        else if(charge < low - hysteresis) state = EmuBatteryStateLow;
    } else if(state == EmuBatteryStateLow) {
        if(charge > low + hysteresis) state = EmuBatteryStateNormal;
        else if(charge < critical - hysteresis) state = EmuBatteryStateCritical;
    } else {
        if(charge > low + hysteresis) state = EmuBatteryStateNormal;
        else if(charge > critical + hysteresis) state = EmuBatteryStateLow;
    }
    if(state == emu_power.battery_state) return;
    static const PowerEventType stop[] = {PowerEventBatteryNormalStop, PowerEventBatteryLowStop, PowerEventBatteryCriticalStop};
    static const PowerEventType start[] = {PowerEventBatteryNormalStart, PowerEventBatteryLowStart, PowerEventBatteryCriticalStart};
    emu_status_publish_power(stop[emu_power.battery_state]);
    emu_power.battery_state = state;
    emu_status_publish_power(start[state]);
}

/**
 * The state the status bar shows: wifi is a WifiState, ble a BleServiceStatus (Ready and earlier hide the icon),
 * volume 0-100, charge 0-100. What changed is announced as the services do, and the status bar redraws it.
 */
EMSCRIPTEN_KEEPALIVE void emu_screen_status(int wifi, int ble, int volume, int usb, int charge, int charging) {
    if(emu_wifi_state_now(&emu_wifi) != (WifiState)wifi) emu_wifi_set_state(&emu_wifi, wifi);

    if(emu_ble.status != (BleServiceStatus)ble) {
        emu_ble.status = ble;
        BleState state = {.status = ble};
        furi_pubsub_publish(emu_ble.pubsub, &state);
    }

    if(emu_audio.volume != volume / 100.0f) {
        emu_audio.volume = volume / 100.0f;
        AudioEvent event = {.type = AudioEventVolumeUpdate};
        furi_pubsub_publish(emu_audio.pubsub, &event);
    }

    if(emu_power.usb_connected != (bool)usb) {
        emu_power.usb_connected = usb;
        emu_status_publish_power(PowerEventUsbConnectionStateUpdate);
    }
    if(emu_power.charge != charge) {
        emu_power.charge = charge;
        emu_status_publish_power(PowerEventChargeAmountUpdate);
    }
    if(emu_power.charging != (bool)charging) {
        emu_power.charging = charging;
        emu_status_publish_power(PowerEventChargingStateUpdate);
    }
    emu_status_battery_state();
    emu_pump();
}

void emu_status_init(void) {
    emu_power = (struct Power){.pubsub = furi_pubsub_alloc(), .usb_connected = true, .charging = false, .charge = 100};
    emu_audio = (struct Audio){.pubsub = furi_pubsub_alloc(), .volume = 0.5f};
    emu_wifi.state = furi_state_alloc(sizeof(WifiInfo));
    emu_wifi_set_state(&emu_wifi, WifiStateConnected);
    emu_ble = (struct Ble){.pubsub = furi_pubsub_alloc(), .status = BleServiceStatusReady};
    furi_record_create(RECORD_POWER, &emu_power);
    furi_record_create(RECORD_AUDIO, &emu_audio);
    furi_record_create(RECORD_WIFI, &emu_wifi);
    furi_record_create(RECORD_BLE, &emu_ble);
}
