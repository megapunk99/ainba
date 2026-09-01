{
  "targets": [
    {
      "target_name": "sharpedge_core",
      "sources": ["sharpedge_core.c"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags": ["-O3", "-march=native", "-ffast-math"],
      "msvs_settings": {
        "VCCLCompilerTool": { "Optimization": 2 }
      }
    }
  ]
}
