allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)

    // Force every Android subproject (Flutter plugins) to compile against SDK 36.
    // file_picker's flutter_plugin_android_lifecycle requires compileSdk >= 36 and
    // the plugins otherwise inherit the older Flutter default. Registered BEFORE
    // evaluationDependsOn below so the project isn't already evaluated.
    afterEvaluate {
        val androidExt = project.extensions.findByName("android")
        if (androidExt != null) {
            try {
                val m = androidExt.javaClass.methods.firstOrNull {
                    it.name == "compileSdkVersion" &&
                        it.parameterCount == 1 &&
                        it.parameterTypes[0] == Int::class.javaPrimitiveType
                }
                m?.invoke(androidExt, 36)
            } catch (e: Exception) {
                println("compileSdk override skipped for ${project.name}: ${e.message}")
            }
        }
    }

    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
