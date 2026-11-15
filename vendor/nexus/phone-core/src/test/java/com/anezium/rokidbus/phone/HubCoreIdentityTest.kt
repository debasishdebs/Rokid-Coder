@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import com.anezium.rokidbus.shared.AppIdentity
import com.example.cxrglobal.CxrDefs
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [ShadowCaps::class], instrumentedPackages = ["com.rokid.cxr"])
class HubCoreIdentityTest {
    @Test
    fun each_shell_targets_its_own_pair() {
        for ((pair, other) in listOf(UPSTREAM_PAIR to ROKID_CODER_PAIR, ROKID_CODER_PAIR to UPSTREAM_PAIR)) {
            val harness = HubCoreHarness(identity = pair)
            assertEquals(pair, harness.core.identity)
            harness.core.start()

            val session = harness.cxr.sessions.single()
            assertEquals(CxrDefs.CXRSessionType.CUSTOMAPP, session.sessionType)
            assertEquals(pair.glassesApplicationId, session.customAppPackageName)

            // The installer pushes only the configured glasses app, never the other pair's.
            val refused = runBlocking {
                harness.core.glassesInstaller.install(File("unused.apk"), metadataFor(other)) {}
            }
            assertEquals(InstallResult.Failed("Glasses APK package does not match this hub."), refused)
            assertTrue(harness.cxr.appCalls.isEmpty())
            harness.core.close()
        }
    }

    private fun metadataFor(identity: AppIdentity) = GlassesApkMetadata(
        packageName = identity.glassesApplicationId,
        versionCode = 10000,
        sha256 = "0".repeat(64),
        signerSha256 = "0".repeat(64),
    )
}
