package org.example.codexmobile
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import io.dcloud.uniapp.sdk.UniAppXSDK
// 按官方离线 SDK 入口启动，完成后关闭仅用于跳转的宿主页面。
class MainActivity : AppCompatActivity() {
 override fun onCreate(savedInstanceState: Bundle?) {
  super.onCreate(savedInstanceState)
  UniAppXSDK.start(null, this)
  finish()
 }
}
