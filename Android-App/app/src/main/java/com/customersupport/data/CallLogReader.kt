package com.customersupport.data

import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.provider.CallLog
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

class CallLogReader(private val context: Context) {
    
    companion object {
        private const val TAG = "CallLogReader"
    }

    fun readCallLogs(limit: Int = 500): JSONArray {
        val callsArray = JSONArray()

        try {
            val contentResolver: ContentResolver = context.contentResolver

            val cursor: Cursor? = contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(
                    CallLog.Calls._ID,
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.TYPE,
                    CallLog.Calls.DURATION,
                    CallLog.Calls.DATE
                ),
                null,
                null,
                "${CallLog.Calls.DATE} DESC"
            )

            cursor?.use {
                val idIndex = it.getColumnIndex(CallLog.Calls._ID)
                val numberIndex = it.getColumnIndex(CallLog.Calls.NUMBER)
                val typeIndex = it.getColumnIndex(CallLog.Calls.TYPE)
                val durationIndex = it.getColumnIndex(CallLog.Calls.DURATION)
                val dateIndex = it.getColumnIndex(CallLog.Calls.DATE)
                var count = 0

                while (it.moveToNext() && count < limit) {
                    count++
                    val id = it.getString(idIndex) ?: ""
                    val number = it.getString(numberIndex) ?: "Unknown"
                    val type = it.getInt(typeIndex)
                    val duration = it.getLong(durationIndex)
                    val date = it.getLong(dateIndex)

                    val callType = when (type) {
                        CallLog.Calls.INCOMING_TYPE -> "incoming"
                        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                        CallLog.Calls.MISSED_TYPE -> "missed"
                        else -> "unknown"
                    }

                    val callJson = JSONObject().apply {
                        put("id", "call_$id")
                        put("number", number)
                        put("type", callType)
                        put("duration", duration)
                        put("timestamp", formatDate(date))
                    }
                    callsArray.put(callJson)
                }
            }

            Log.d(TAG, "Read ${callsArray.length()} call logs")
        } catch (e: SecurityException) {
            Log.e(TAG, "Permission denied to read call logs", e)
        } catch (e: Exception) {
            Log.e(TAG, "Error reading call logs", e)
        }

        return callsArray
    }

    private fun formatDate(timestamp: Long): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date(timestamp))
    }
}
