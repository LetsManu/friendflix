// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
package app.friendflix.android.settings

import android.app.AlertDialog
import android.content.DialogInterface
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import app.friendflix.android.BuildConfig
import app.friendflix.android.R
import app.friendflix.android.downloads.DownloadState
import app.friendflix.android.downloads.LIC
import app.friendflix.android.downloads.TestEnv
import app.friendflix.android.offline.Offline
import app.friendflix.android.setup.SetupActivity
import app.friendflix.android.shell.ShellActivity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowLooper
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class SettingsScreenTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var env: TestEnv
    private lateinit var offline: Offline
    private val signOuts = AtomicInteger()
    private val leaves = AtomicInteger()

    @Before fun setUp() {
        env = TestEnv(tmp.newFolder("env"))
        offline = Offline(env.deps, tmp.newFolder("state"))
        Offline.install(offline)
        env.complete(LIC)
        env.add(env.record(LIC, DownloadState.DONE).copy(title = "Alpha"))
    }

    @After fun tearDown() {
        Offline.install(null)
        env.close()
    }

    /** The real reset with the WebView and Keystore parts faked (DeviceResetTest covers those). */
    private fun fakeReset(a: SettingsActivity) {
        a.reset = { DeviceReset(a.applicationContext, offline, web = {}, wipeKeys = {}) }
    }

    private fun waitFor(what: String, cond: () -> Boolean) {
        val until = System.currentTimeMillis() + 10_000
        while (!cond() && System.currentTimeMillis() < until) { ShadowLooper.idleMainLooper(); Thread.sleep(10) }
        assertTrue(what, cond())
    }

    private fun withScreen(block: (ActivityScenario<SettingsActivity>, SettingsActivity) -> Unit) {
        ActivityScenario.launch(SettingsActivity::class.java).use { s ->
            var act: SettingsActivity? = null
            s.onActivity { act = it }
            val a = act!!
            waitFor("bound") { a.findViewById<LinearLayout>(R.id.settings_notify_categories).childCount == 4 && a.findViewById<RadioGroup>(R.id.settings_storage).childCount > 0 }
            block(s, a)
        }
    }

    private fun latestDialog(): AlertDialog = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog

    @Test fun showsTheServerVersionAndStoragePlaces() = withScreen { scenario, a ->
        val host = env.server.url("/").let { "${it.host}:${it.port}" }
        assertEquals(host, a.findViewById<TextView>(R.id.settings_server_value).text.toString())
        assertTrue(a.findViewById<TextView>(R.id.settings_version).text.contains(BuildConfig.VERSION_NAME))
        val places = a.findViewById<RadioGroup>(R.id.settings_storage)
        assertEquals(2, places.childCount)
        val phone = places.getChildAt(0) as RadioButton
        assertTrue(phone.isChecked)
        assertTrue(phone.text.toString(), phone.text.startsWith("Phone · ") && phone.text.endsWith(" free"))
        env.volumes.sdMounted = false
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.STARTED)
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED) // back on the screen: the places are read again
        waitFor("card shown as missing") { (places.getChildAt(1) as? RadioButton)?.text == a.getString(R.string.settings_storage_sd_missing) }
        assertFalse((places.getChildAt(1) as RadioButton).isEnabled)
    }

    @Test fun notificationCategoriesStoreTheEnabledIds() = withScreen { _, a ->
        val box = a.findViewById<LinearLayout>(R.id.settings_notify_categories)
        val boxes = (0 until box.childCount).map { box.getChildAt(it) as CheckBox }
        assertTrue(boxes.all { it.isChecked }) // never chosen = all on
        boxes.first { it.tag == "requests" }.performClick()
        waitFor("stored") { runBlocking { env.settings.notifyCategoriesChosen.first() } == setOf("new", "account", "other") }
    }

    @Test fun wifiOnlyAndBackgroundAudioAreStored() = withScreen { _, a ->
        a.findViewById<CheckBox>(R.id.settings_wifi_only).performClick()
        a.findViewById<CheckBox>(R.id.settings_background_audio).performClick()
        waitFor("stored") { runBlocking { env.settings.wifiOnly.first() && env.settings.backgroundAudio.first() } }
    }

    @Test fun pickingTheCardOffersToMoveTheFinishedDownloads() = withScreen { _, a ->
        val places = a.findViewById<RadioGroup>(R.id.settings_storage)
        (places.getChildAt(1) as RadioButton).performClick()
        val d = latestDialog()
        assertTrue(d.isShowing)
        d.getButton(DialogInterface.BUTTON_NEGATIVE).performClick() // only new downloads
        waitFor("stored") { runBlocking { env.settings.storage.first() } == StorageLocation.SD }
        assertEquals(StorageLocation.PHONE, env.store.get(LIC)!!.location) // nothing moved
    }

    @Test fun signOutAsksFirstAndCancelKeepsEverything() = withScreen { _, a ->
        fakeReset(a)
        a.findViewById<Button>(R.id.settings_sign_out).performClick()
        latestDialog().getButton(DialogInterface.BUTTON_NEGATIVE).performClick()
        ShadowLooper.idleMainLooper()
        Thread.sleep(200)
        ShadowLooper.idleMainLooper()
        assertNotNull(env.store.get(LIC))
        assertTrue(env.video(LIC).isFile)
    }

    @Test fun signOutAfterTheConfirmationWipesTheDeviceAndOpensTheShell() = withScreen { _, a ->
        fakeReset(a)
        a.done = { signOuts.incrementAndGet() }
        a.findViewById<Button>(R.id.settings_sign_out).performClick()
        latestDialog().getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        waitFor("reset done") { signOuts.get() == 1 }
        assertNull(env.store.get(LIC))
        assertFalse(env.video(LIC).exists())
        val next = shadowOf(ApplicationProvider.getApplicationContext<android.app.Application>()).nextStartedActivity
        assertEquals(ShellActivity::class.java.name, next.component?.className)
    }

    @Test fun theSameServerIsNotAChange() = withScreen { _, a ->
        a.findViewById<Button>(R.id.settings_server_change).performClick()
        val input = latestDialog()
        input.getButton(DialogInterface.BUTTON_POSITIVE).performClick() // prefilled with the current address
        ShadowLooper.idleMainLooper()
        assertTrue(latestDialog() === input) // no confirmation dialog
        assertNotNull(env.store.get(LIC))
    }

    @Test fun aNewServerAsksThenClearsAndRunsSetupForIt() = withScreen { _, a ->
        fakeReset(a)
        a.done = { leaves.incrementAndGet() }
        a.findViewById<Button>(R.id.settings_server_change).performClick()
        val input = latestDialog()
        // the dialog's only EditText
        val field = generateSequence(listOf(input.window!!.decorView)) { level -> level.flatMap { v -> (v as? android.view.ViewGroup)?.let { g -> (0 until g.childCount).map(g::getChildAt) } ?: emptyList() }.takeIf { it.isNotEmpty() } }
            .flatten().filterIsInstance<EditText>().first()
        field.setText("other.example.com")
        input.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        ShadowLooper.idleMainLooper() // the dialog posts its button clicks
        val confirm = latestDialog()
        assertTrue(confirm !== input)
        assertTrue(shadowOf(confirm).message.contains("other.example.com"))
        confirm.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        waitFor("reset done") { leaves.get() == 1 }
        assertNull(env.store.get(LIC))
        assertNull(runBlocking { env.settings.serverOrigin.first() })
        val next = shadowOf(ApplicationProvider.getApplicationContext<android.app.Application>()).nextStartedActivity
        assertEquals(SetupActivity::class.java.name, next.component?.className)
        assertEquals("other.example.com", next.getStringExtra("app.friendflix.android.SETUP_ADDRESS"))
    }
}
