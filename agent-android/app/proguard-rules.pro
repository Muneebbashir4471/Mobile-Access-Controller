# OkHttp ships its own consumer rules. Keep the device admin receiver referenced from the manifest by name.
-keep class com.yourorg.agent.AdminReceiver
-keep class org.webrtc.** { *; }
