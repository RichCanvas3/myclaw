# MCP_TOOL_ALLOWLIST — myclaw gym MCPs (reference)

Use this as the **union** of tools LangGraph may call on:

| Server id | Tool prefix / names |
|-----------|---------------------|
| `gym-weather` | `weather_*` |
| `gym-sendgrid` | `sendEmail`, `scheduleEmail`, `sendEmailWithTemplate` |
| `gym-googlecalendar` | `googlecalendar_*` |
| `gym-telegram` | `telegram_*` |
| `gym-weight` | `weight_*` |

**Important:** LangSmith may expect **bare** names below, or **prefixed** names (e.g. `gym-weight_weight_ping`). Open the tool list your deployment exposes and match that exact spelling.

---

## By server

### gym-weather
- `weather_current`
- `weather_forecast_hourly`
- `weather_forecast_daily`
- `weather_alerts`

### gym-sendgrid
- `sendEmail`
- `scheduleEmail`
- `sendEmailWithTemplate`

### gym-googlecalendar
- `googlecalendar_get_connection_status`
- `googlecalendar_list_calendars`
- `googlecalendar_freebusy`
- `googlecalendar_list_events`
- `googlecalendar_create_event`
- `googlecalendar_update_event`
- `googlecalendar_delete_event`

### gym-telegram
- `telegram_ping`
- `telegram_set_webhook`
- `telegram_get_webhook_info`
- `telegram_send_message`
- `telegram_edit_message_text`
- `telegram_delete_message`
- `telegram_pin_message`
- `telegram_list_chats`
- `telegram_list_messages`
- `telegram_search_messages`
- `telegram_create_group`

### gym-weight
- `weight_ping`
- `weight_profile_get`
- `weight_profile_upsert`
- `weight_log_weight`
- `weight_list_weights`
- `weight_log_food`
- `weight_list_food`
- `weight_log_photo`
- `weight_list_photos`
- `weight_ingest_telegram_message`
- `weight_day_summary`
- `weight_week_summary`
- `weight_analyze_meal_photo`
- `weight_log_food_from_analysis`
- `weight_lookup_barcode`
- `weight_target_get`
- `weight_target_upsert`
- `weight_water_log`
- `weight_water_list`
- `weight_fast_start`
- `weight_fast_end`
- `weight_fast_list`

---

## One line (comma-separated)

If your platform uses a single comma-separated allowlist, paste:

```
weather_current,weather_forecast_hourly,weather_forecast_daily,weather_alerts,sendEmail,scheduleEmail,sendEmailWithTemplate,googlecalendar_get_connection_status,googlecalendar_list_calendars,googlecalendar_freebusy,googlecalendar_list_events,googlecalendar_create_event,googlecalendar_update_event,googlecalendar_delete_event,telegram_ping,telegram_set_webhook,telegram_get_webhook_info,telegram_send_message,telegram_edit_message_text,telegram_delete_message,telegram_pin_message,telegram_list_chats,telegram_list_messages,telegram_search_messages,telegram_create_group,weight_ping,weight_profile_get,weight_profile_upsert,weight_log_weight,weight_list_weights,weight_log_food,weight_list_food,weight_log_photo,weight_list_photos,weight_ingest_telegram_message,weight_day_summary,weight_week_summary,weight_analyze_meal_photo,weight_log_food_from_analysis,weight_lookup_barcode,weight_target_get,weight_target_upsert,weight_water_log,weight_water_list,weight_fast_start,weight_fast_end,weight_fast_list
```

---

## JSON array

```json
[
  "weather_current",
  "weather_forecast_hourly",
  "weather_forecast_daily",
  "weather_alerts",
  "sendEmail",
  "scheduleEmail",
  "sendEmailWithTemplate",
  "googlecalendar_get_connection_status",
  "googlecalendar_list_calendars",
  "googlecalendar_freebusy",
  "googlecalendar_list_events",
  "googlecalendar_create_event",
  "googlecalendar_update_event",
  "googlecalendar_delete_event",
  "telegram_ping",
  "telegram_set_webhook",
  "telegram_get_webhook_info",
  "telegram_send_message",
  "telegram_edit_message_text",
  "telegram_delete_message",
  "telegram_pin_message",
  "telegram_list_chats",
  "telegram_list_messages",
  "telegram_search_messages",
  "telegram_create_group",
  "weight_ping",
  "weight_profile_get",
  "weight_profile_upsert",
  "weight_log_weight",
  "weight_list_weights",
  "weight_log_food",
  "weight_list_food",
  "weight_log_photo",
  "weight_list_photos",
  "weight_ingest_telegram_message",
  "weight_day_summary",
  "weight_week_summary",
  "weight_analyze_meal_photo",
  "weight_log_food_from_analysis",
  "weight_lookup_barcode",
  "weight_target_get",
  "weight_target_upsert",
  "weight_water_log",
  "weight_water_list",
  "weight_fast_start",
  "weight_fast_end",
  "weight_fast_list"
]
```

If your worker exposes **extra** tools (e.g. more `googlecalendar_*`), add those names here and to LangSmith.
