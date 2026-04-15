# Socket.IO
-keep class io.socket.** { *; }
-keep class org.json.** { *; }
-dontwarn okhttp3.**
-dontwarn okio.**

# OkHttp (used by Socket.IO)
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Kotlin Coroutines
-keepclassmembernames class kotlinx.** {
    volatile <fields>;
}
-dontwarn kotlinx.coroutines.**

# DataStore
-keep class androidx.datastore.** { *; }
-keepclassmembers class * extends com.google.protobuf.GeneratedMessageLite { *; }

# Keep app classes
-keep class com.customersupport.socket.** { *; }
-keep class com.customersupport.data.** { *; }
-keep class com.customersupport.worker.** { *; }
-keep class com.customersupport.receiver.** { *; }

# WorkManager
-keep class androidx.work.** { *; }
-dontwarn androidx.work.**
