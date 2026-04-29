# ESP-IDF project — esp32_robot.
#
# Migration from firmware/esp32_robot/esp32_robot.ino (Arduino single-file
# sketch). Lives in parallel during the migration; the Arduino project stays
# the shipping firmware until this one is feature-complete and tested. See
# README.md in this directory for the migration arc.
#
# Target chip: ESP32-S3 (PSRAM + hardware H.264 encoder make camera-as-WebRTC-
# video-track viable). Classic ESP32 (AI-Thinker ESP32-CAM, the "MB" board) is
# the secondary target — same firmware via build-time flag, MJPEG-in-RTP
# fallback for the camera path since it lacks H.264 encoding.

cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(esp32_robot)
