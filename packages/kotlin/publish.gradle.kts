// publish.gradle.kts — Maven Central publish template for the Kotlin SDK.
//
// STATUS: template only, NOT a working build. This repo has no Gradle wrapper
// and no build.gradle(.kts) yet — the Kotlin SDK is single-file sources under
// src/main/kotlin. Do not invent a whole build around this file. When a Gradle
// wrapper + kotlin("jvm") module lands, apply it from that module build with:
//
//     apply(from = rootProject.file("packages/kotlin/publish.gradle.kts"))
//
// Prerequisites the host build must provide:
//   - plugins: kotlin("jvm"), `maven-publish`, signing
//     (this script applies maven-publish + signing itself; kotlin-jvm must come
//     from the host build because plugin versions live there)
//   - java { withSourcesJar(); withJavadocJar() }  (required by Central)
//   - env secrets (never files, never committed):
//       OSSRH_USERNAME / OSSRH_PASSWORD   Sonatype token (GitHub Secrets)
//       GPG_PRIVATE_KEY (armored) / GPG_PASSPHRASE
//     Locally: ./gradlew publishToMavenLocal  (no secrets needed, no signing)
//     Release: RELEASE_VERSION is set by .github/workflows/release.yml from the
//     v* tag (tag without the leading v, e.g. v0.2.0 -> 0.2.0).

plugins {
    `maven-publish`
    signing
}

// ---- coordinates -----------------------------------------------------------
// Group tv.openseek (NOT com.github.Yatin-Code):
//   - brand-scoped, matching the npm @openseek scope and the OpenSeek product
//     name; survives a future move off a personal GitHub account.
//   - com.github.<user> is not a valid Sonatype group anyway — GitHub-derived
//     groups are io.github.<user>. If Sonatype rejects the tv.openseek
//     namespace, the approved fallback is io.github.yatin-code (auto-approved
//     via the Yatin-Code GitHub org); update this file + docs/PUBLISHING.md +
//     consumers if that happens.
group = "tv.openseek"

// Pre-release marker by default: a stray local `./gradlew publish` can never
// ship something claiming to be final. CI overrides via RELEASE_VERSION.
version = System.getenv("RELEASE_VERSION")?.removePrefix("v") ?: "0.2.0-unreleased"

val ossrhUsername = System.getenv("OSSRH_USERNAME")
val ossrhPassword = System.getenv("OSSRH_PASSWORD")
val gpgKey = System.getenv("GPG_PRIVATE_KEY")
val gpgPassphrase = System.getenv("GPG_PASSPHRASE")

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"]) // host build must apply kotlin("jvm")
            artifactId = "openseek-sdk-jvm"
            pom {
                name.set("openseek-sdk-jvm")
                description.set("Pure-JVM client for the OpenSeek seek-preview registry")
                url.set("https://github.com/Yatin-Code/openseek-sdk")
                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
                developers {
                    developer {
                        id.set("yatin-code")
                        url.set("https://github.com/Yatin-Code")
                    }
                }
                scm {
                    connection.set("scm:git:https://github.com/Yatin-Code/openseek-sdk.git")
                    developerConnection.set("scm:git:https://github.com/Yatin-Code/openseek-sdk.git")
                    url.set("https://github.com/Yatin-Code/openseek-sdk")
                }
            }
        }
    }
    repositories {
        maven {
            name = "sonatype"
            // OSSRH staging endpoint. If the namespace was created on the new
            // Central Portal (central.sonatype.com) instead of legacy OSSRH,
            // replace this URL with the Portal's publish endpoint per its docs
            // and adjust the release job's close/release step accordingly.
            url = uri("https://s01.oss.sonatype.org/service/local/staging/deploy/maven2/")
            credentials {
                username = ossrhUsername
                password = ossrhPassword
            }
        }
    }
}

// Signing is registered ONLY when the key is present (CI release job). Local
// builds (./gradlew build, publishToMavenLocal) work with no secrets at all.
if (!gpgKey.isNullOrBlank()) {
    signing {
        useInMemoryPgpKeys(gpgKey, gpgPassphrase)
        sign(publishing.publications["maven"])
    }
}
