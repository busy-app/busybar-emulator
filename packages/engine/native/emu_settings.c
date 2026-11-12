// SETTINGS: the firmware's settings menu and the programs it lists, with the services they read and set.
#include <furi.h>

#include <applications.h>

int32_t ble_settings_entry(void* arg);
int32_t wifi_settings_entry(void* arg);
int32_t matter_settings_entry(void* arg);
int32_t account_settings_entry(void* arg);
int32_t sound_settings_entry(void* arg);
int32_t brightness_settings_entry(void* arg);
int32_t time_settings_entry(void* arg);
int32_t firmware_settings_entry(void* arg);
int32_t system_settings_entry(void* arg);
int32_t about_entry(void* arg);
int32_t debug_app_list_entry(void* arg);

// In the order fbt lists them: by `order` in each application.fam.
const FlipperInternalApplication FLIPPER_SETTINGS_APPS[] = {
    {.app = ble_settings_entry, .name = "Ble settings", .appid = "ble_settings"},
    {.app = wifi_settings_entry, .name = "Wifi settings", .appid = "wifi_settings"},
    {.app = matter_settings_entry, .name = "Matter settings", .appid = "matter_settings"},
    {.app = account_settings_entry, .name = "Account settings", .appid = "account_settings"},
    {.app = sound_settings_entry, .name = "Sound settings", .appid = "sound_settings"},
    {.app = brightness_settings_entry, .name = "Brightness settings", .appid = "brightness_settings"},
    {.app = time_settings_entry, .name = "Time settings", .appid = "time_settings"},
    {.app = firmware_settings_entry, .name = "Firmware Settings", .appid = "firmware_settings"},
    {.app = system_settings_entry, .name = "System Settings", .appid = "system_settings"},
    {.app = about_entry, .name = "About", .appid = "about"},
    {.app = debug_app_list_entry, .name = "Debug app list", .appid = "debug_app_list"},
};
const size_t FLIPPER_SETTINGS_APPS_COUNT = COUNT_OF(FLIPPER_SETTINGS_APPS);

// The bar's debug programs (display tests and the like) are not in the emulator.
const FlipperInternalApplication FLIPPER_DEBUG_APPS[] = {{0}};
const size_t FLIPPER_DEBUG_APPS_COUNT = 0;

// ================================================================ the services the settings programs read and set
//
// The emulated bar is a bar out of the box: not linked to an account, in no smart home, with nothing to update and
// nothing to pair. Each service below answers that way; what a program changes that the emulator has a use for
// (volume, brightness, time zone, Wi-Fi) goes to the host, see host_setting_changed().

#include <applications/system/updater/updater.h>
#include <device_name/device_name.h>
#include <furi_hal_version.h>
#include <matter/matter.h>
#include <mqtt/mqtt.h>
#include <sl_info/sl_info.h>
#include <sysctl/sysctl.h>
#include <time/time.h>
#include <toolbox/timers.h>
#include <toolbox/update_lib/factory_reset.h>
#include <utz/utz.h>
#include <version/version.h>

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include <furi_hal_rtc.h>
#include <storage_utils/temp_file.h>

#include "host.h"
#include "shim.h"

// ---------------------------------------------------------------- records and timers

bool furi_record_exists(const char* name) {
    return furi_record_open_ex(name, 0) != NULL;
}

// A FuriTimer is an event-loop timer without a loop here: the host fires both.
FuriTimer* furi_timer_alloc(FuriTimerCallback func, FuriTimerType type, void* context) {
    return (FuriTimer*)furi_event_loop_timer_alloc(
        NULL, func, type == FuriTimerTypePeriodic ? FuriEventLoopTimerTypePeriodic : FuriEventLoopTimerTypeOnce, context);
}

void furi_timer_free(FuriTimer* instance) {
    furi_event_loop_timer_free((FuriEventLoopTimer*)instance);
}

FuriStatus furi_timer_start(FuriTimer* instance, uint32_t ticks) {
    furi_event_loop_timer_start((FuriEventLoopTimer*)instance, ticks);
    return FuriStatusOk;
}

FuriStatus furi_timer_stop(FuriTimer* instance) {
    furi_event_loop_timer_stop((FuriEventLoopTimer*)instance);
    return FuriStatusOk;
}

// toolbox/timers.c: a deadline in ticks.
CoarseTimer coarse_timer_create(uint32_t timeout_ms) {
    return (CoarseTimer){.data = {furi_get_tick(), timeout_ms}};
}

bool coarse_timer_is_expired(const CoarseTimer timer) {
    return furi_get_tick() - timer.data[0] >= timer.data[1];
}

// ---------------------------------------------------------------- time: the zone is the host's

void time_get_settings(const Time* instance, TimeSettings* settings) {
    (void)instance;
    memset(settings, 0, sizeof(TimeSettings));
    settings->is_enabled = true;
    strlcpy(settings->server_address, "pool.ntp.org", sizeof(settings->server_address));
    settings->time_format = TimeSettingTimeFormat24h;
    char* name = host_timezone();
    if(!utz_get_zone_by_name(name, &settings->timezone)) utz_get_zone_by_name("Universal", &settings->timezone);
    free(name);
}

bool time_set_settings(Time* instance, const TimeSettings* settings) {
    (void)instance;
    host_setting_changed("timezone", settings->timezone.name);
    return true;
}

// time.c's do_get_local_time: the clock moved by the zone's offset at that moment.
LocalTime time_get_local_time(Time* instance) {
    TimeSettings settings;
    time_get_settings(instance, &settings);
    LocalTime result;
    DateTime now = furi_hal_rtc_get_datetime().dt;
    utz_get_current_offset(&settings.timezone, &now, &result.offset);
    result.dt = utz_udatetime_add(&now, &result.offset);
    return result;
}

// ---------------------------------------------------------------- device name, hardware and firmware versions

static FuriState* emu_device_name;

FuriState* device_name_get_state(const DeviceName* instance) {
    (void)instance;
    if(!emu_device_name) {
        emu_device_name = furi_state_alloc(sizeof(DeviceNameInfo));
        DeviceNameInfo info = {.name = "BUSY Bar Emulator"};
        furi_state_set(emu_device_name, &info);
    }
    return emu_device_name;
}

void device_name_get(DeviceName* instance, FuriString* name) {
    DeviceNameInfo info;
    furi_state_get(device_name_get_state(instance), &info);
    furi_string_set_str(name, info.name);
}

// device_name.c's device_name_validate().
static bool emu_device_name_validate_char(char c) {
    static const char* const allowed_special_chars = " !()-_=+;:,.?'|@#$%^&*[]{}/\\\"<>";
    bool allowed_ascii = isalnum(c) || strchr(allowed_special_chars, c);
    bool utf8 = c >= 128;
    bool null = c == 0;
    return allowed_ascii && !utf8 && !null;
}

static DeviceNameError emu_device_name_validate(const char* name) {
    if(strnlen(name, DEVICE_NAME_MAX_SIZE) == 0) return DeviceNameErrorEmpty;
    bool only_contains_spaces = true;
    for(size_t i = 0; i < strlen(name); i++) {
        char c = name[i];
        if(c != ' ') only_contains_spaces = false;
        if(!emu_device_name_validate_char(c)) return DeviceNameErrorIllegalChar;
    }
    if(only_contains_spaces) return DeviceNameErrorOnlySpaces;
    if(strnlen(name, DEVICE_NAME_MAX_SIZE) > DEVICE_NAME_MAX_LENGTH) return DeviceNameErrorTooLong;
    return DeviceNameErrorNone;
}

// The host is told the new name: it reports it in the state stream.
DeviceNameError device_name_set(DeviceName* instance, const char* name) {
    DeviceNameError error = emu_device_name_validate(name);
    if(error != DeviceNameErrorNone) return error;
    DeviceNameInfo info = {0};
    strlcpy(info.name, name, sizeof(info.name));
    furi_state_set(device_name_get_state(instance), &info);
    host_setting_changed("name", info.name);
    return DeviceNameErrorNone;
}

const Version* version_get(void) {
    static const int version;
    return (const Version*)&version;
}

const char* version_get_version(const Version* v) {
    (void)v;
    return EMU_FW_VERSION;
}

const char* version_get_githash(const Version* v) {
    (void)v;
    return EMU_FW_COMMIT;
}

const char* version_get_gitbranch(const Version* v) {
    (void)v;
    return "emulator";
}

const char* version_get_builddate(const Version* v) {
    (void)v;
    // The date of the firmware commit, by the rule of the firmware's own build script (fbtng/scripts/version.py); not
    // checked on a bar. Never the day of this build.
    return EMU_FW_BUILD_DATE;
}

const char* updater_get_active_version(void) {
    return EMU_FW_VERSION;
}

static const uint8_t emu_uid[12] = {'E', 'M', 'U', 'L', 'A', 'T', 'O', 'R', 0, 0, 0, 1};

const uint8_t* furi_hal_version_uid(void) {
    return emu_uid;
}

size_t furi_hal_version_uid_size(void) {
    return sizeof(emu_uid);
}

const uint8_t* furi_hal_version_get_usb_mac(void) {
    static const uint8_t mac[6] = {0x02, 0x00, 0x00, 0x00, 0x00, 0x01};
    return mac;
}

uint8_t furi_hal_version_get_hw_version(void) {
    return 0;
}

uint8_t furi_hal_version_get_hw_target(void) {
    return 22;
}

uint8_t furi_hal_version_get_hw_body(void) {
    return 0;
}

uint8_t furi_hal_version_get_hw_connect(void) {
    return 0;
}

const char* furi_hal_version_get_fcc_id(void) {
    return "emulator";
}

const char* furi_hal_version_get_ic_id(void) {
    return "emulator";
}

// What the Wi-Fi chip reports of itself: the two addresses the About program lists (the ones GET /api/status/device
// gives), nothing else.
SlInfoStatus sl_info_get_value(const SlInfo* instance, const char* key, const char** value) {
    (void)instance;
    if(strcmp(key, "sl_wifi_mac") == 0) {
        *value = "02:00:00:00:00:02";
        return SlInfoStatusOk;
    }
    if(strcmp(key, "sl_ble_mac") == 0) {
        *value = "02:00:00:00:00:03";
        return SlInfoStatusOk;
    }
    return SlInfoStatusNotFound;
}

// ---------------------------------------------------------------- updater: nothing to update

static FuriState* emu_update_check;

FuriState* updater_get_check_state(Updater* instance) {
    (void)instance;
    if(!emu_update_check) {
        emu_update_check = furi_state_alloc(sizeof(UpdaterCheckState));
        UpdaterCheckState state = {.result = UpdaterCheckResultNotAvailable, .event = UpdaterCheckEventNone};
        furi_state_set(emu_update_check, &state);
    }
    return emu_update_check;
}

// A check ends at once: the emulator's firmware is the one it was built from.
UpdaterStatus updater_check_for_update(Updater* instance) {
    UpdaterCheckState state = {.result = UpdaterCheckResultNotAvailable, .event = UpdaterCheckEventStop};
    furi_state_set(updater_get_check_state(instance), &state);
    return UpdaterStatusOk;
}

void updater_get_check_info(Updater* instance, UpdateCheckInfo* info) {
    (void)instance;
    (void)info;
}

UpdaterStatus updater_get_allowance_status(Updater* instance) {
    (void)instance;
    return UpdaterStatusOk;
}

static UpdaterSettings emu_updater_settings = {
    .check_channel_id = UPDATER_SETTINGS_CHECK_CHANNEL_ID_RELEASE,
    .autoupdate_enabled = false,
    .autoupdate_interval_start = 2 * 60,
    .autoupdate_interval_end = 5 * 60,
};

void updater_get_settings(const Updater* instance, UpdaterSettings* settings) {
    (void)instance;
    *settings = emu_updater_settings;
}

bool updater_set_settings(Updater* instance, const UpdaterSettings* settings) {
    (void)instance;
    emu_updater_settings = *settings;
    return true;
}

// updater.c's texts for a status.
const char* updater_get_status_string(UpdaterStatus status) {
    static const char* const status_strings[] = {
        [UpdaterStatusOk] = "Success",
        [UpdaterStatusBatteryLow] = "Battery level too low",
        [UpdaterStatusBusy] = "Operation already in progress",
        [UpdaterStatusDownloadFailure] = "Failed to download update bundle",
        [UpdaterStatusDownloadAbort] = "Download aborted",
        [UpdaterStatusShaMismatch] = "SHA256 checksum verification failed",
        [UpdaterStatusUnpackCreateStagingDirectoryFailure] = "Failed to create staging directory",
        [UpdaterStatusUnpackArchiveOpenFailure] = "Failed to open tar file",
        [UpdaterStatusUnpackArchiveUnpackFailure] = "Failed to unpack tar file",
        [UpdaterStatusInstallationPrepareManifestNotFound] = "Manifest not found",
        [UpdaterStatusInstallationPrepareManifestInvalid] = "Failed to validate manifest",
        [UpdaterStatusInstallationPrepareSecurityMismatch] = "Bundle security mismatch",
        [UpdaterStatusInstallationPrepareSessionConfigSetupFailure] = "Failed to save session config",
        [UpdaterStatusInstallationPreparePointerSetupFailure] = "Failed to write pointer file",
        [UpdaterStatusUnknownFailure] = "Unknown error",
    };
    return (status < UpdaterStatusesCount) ? status_strings[status] : "Unknown error code";
}

// Nothing is ever being installed.
static FuriState* emu_update_state;

FuriState* updater_get_update_state(Updater* instance) {
    (void)instance;
    if(!emu_update_state) {
        emu_update_state = furi_state_alloc(sizeof(UpdaterUpdateState));
        UpdaterUpdateState state = {.event = UpdaterUpdateEventNone, .action = UpdaterUpdateActionNone, .status = UpdaterStatusOk};
        furi_state_set(emu_update_state, &state);
    }
    return emu_update_state;
}

void updater_abort_download(Updater* instance) {
    (void)instance;
}

// An update bundle sent to the emulator (POST /api/update) is answered by the host; these are never reached.
UpdaterStatus updater_unpack(Updater* instance, const char* tar_path, const char* staging_path, FuriString* manifest_path, bool do_wait) {
    (void)instance;
    (void)tar_path;
    (void)staging_path;
    (void)manifest_path;
    (void)do_wait;
    return UpdaterStatusUnpackArchiveOpenFailure;
}

UpdaterStatus updater_installation_prepare(Updater* instance, const char* manifest_path, bool do_wait) {
    (void)instance;
    (void)manifest_path;
    (void)do_wait;
    return UpdaterStatusInstallationPrepareManifestNotFound;
}

void updater_installation_apply(Updater* instance, bool do_wait) {
    (void)instance;
    (void)do_wait;
}

TempFile* temp_file_alloc(Storage* storage) {
    (void)storage;
    return NULL;
}

void temp_file_free(TempFile* instance) {
    (void)instance;
}

bool temp_file_create(TempFile* instance, const char* path) {
    (void)instance;
    (void)path;
    return false;
}

bool temp_file_write(TempFile* instance, const void* data, size_t data_len) {
    (void)instance;
    (void)data;
    (void)data_len;
    return false;
}

bool temp_file_remove(TempFile* instance) {
    (void)instance;
    return false;
}

FuriThreadPriority furi_thread_get_current_priority(void) {
    return FuriThreadPriorityNormal;
}

// An update session keeps everything else from updating while its owner installs or resets. Nothing in the emulator
// updates by itself, so a session starts unless one is open. (The factory reset polls until it gets one.)
static bool emu_update_session;

UpdaterStatus updater_session_start(Updater* instance) {
    (void)instance;
    if(emu_update_session) return UpdaterStatusBusy;
    emu_update_session = true;
    return UpdaterStatusOk;
}

void updater_session_stop(Updater* instance) {
    (void)instance;
    emu_update_session = false;
}

void updater_install_from_url(Updater* instance, const char* url, const char* sha256) {
    (void)instance;
    (void)url;
    (void)sha256;
}

// ---------------------------------------------------------------- account (MQTT): not linked

static FuriPubSub* emu_mqtt_pubsub;

FuriPubSub* mqtt_get_pubsub(Mqtt* instance) {
    (void)instance;
    if(!emu_mqtt_pubsub) emu_mqtt_pubsub = furi_pubsub_alloc();
    return emu_mqtt_pubsub;
}

// As a bar that is online and has no account: the account program offers a pairing code. Asking for one fails (see
// mqtt_request_link_pin): there is no cloud to issue it.
MqttStatus mqtt_get_status(Mqtt* instance) {
    (void)instance;
    return MqttStatusConnectedNotLinked;
}

void mqtt_get_session_info(Mqtt* instance, MqttSessionInfo* info) {
    (void)instance;
    info->is_valid = false;
}

bool mqtt_request_link_pin(Mqtt* instance) {
    (void)instance;
    return false;
}

void mqtt_unlink(Mqtt* instance) {
    (void)instance;
}

// The cloud the bar would talk to (GET and PUT /api/account/backend): kept, never connected to.
static MqttConfig emu_mqtt_config = {.server_url = MQTT_CONFIG_SERVER_URL_DEFAULT, .client_cert_type = MqttClientCertTypeDefault, .ignore_server_cert = false};

void mqtt_get_config(Mqtt* instance, MqttConfig* config) {
    (void)instance;
    *config = emu_mqtt_config;
}

bool mqtt_set_config(Mqtt* instance, const MqttConfig* config) {
    (void)instance;
    if(!mqtt_config_is_valid(config)) return false;
    emu_mqtt_config = *config;
    return true;
}

// ---------------------------------------------------------------- smart home (Matter): in no fabric

static FuriPubSub* emu_matter_pubsub;

FuriPubSub* matter_get_pubsub(Matter* instance) {
    (void)instance;
    if(!emu_matter_pubsub) emu_matter_pubsub = furi_pubsub_alloc();
    return emu_matter_pubsub;
}

MatterStatus matter_get_commissioned_fabrics(Matter* instance, MatterCommissionedFabrics* fabrics) {
    (void)instance;
    memset(fabrics, 0, sizeof(MatterCommissionedFabrics));
    fabrics->last_status = MatterCommissioningStatusNeverStarted;
    return MatterStatusOk;
}

MatterStatus matter_enable_commissioning(Matter* instance, MatterCommissioningInfo* info) {
    (void)instance;
    (void)info;
    return MatterStatusUnprovisioned;
}

MatterStatus matter_factory_reset(Matter* instance, MatterReboot reboot) {
    (void)instance;
    (void)reboot;
    return MatterStatusOk;
}

// ---------------------------------------------------------------- system settings

void sysctl_set_debug_enabled(bool enabled) {
    (void)enabled;
}

// A bar erases its data and restarts inside this call (the system settings spin in an empty loop after it). The
// emulated bar restarts too; the host decides what becomes of the data.
void factory_reset_perform(Updater* updater, bool shipping_mode) {
    (void)updater;
    (void)shipping_mode;
    host_setting_changed("factory_reset", "");
    emu_halt(false);
}

// ---------------------------------------------------------------- what the supervisor watches

#include <intercom/intercom.h>
#include <storage/storage.h>

// The link between the bar's two processors: always in order.
FuriState* intercom_get_state(const Intercom* instance) {
    (void)instance;
    static FuriState* state;
    if(!state) {
        state = furi_state_alloc(sizeof(IntercomStatus));
        IntercomStatus ok = IntercomStatusOk;
        furi_state_set(state, &ok);
    }
    return state;
}

// The partitions of the bar's flash: both there, never remade.
FS_Error storage_sd_status(Storage* storage, const char* path) {
    (void)storage;
    (void)path;
    return FSE_OK;
}

FS_Error storage_sd_format(Storage* storage, const char* path) {
    (void)storage;
    (void)path;
    return FSE_OK;
}

FS_Error storage_sd_make_filesystem(Storage* storage, const char* path) {
    (void)storage;
    (void)path;
    return FSE_OK;
}

const char* storage_error_get_desc(FS_Error error_id) {
    (void)error_id;
    return "";
}
