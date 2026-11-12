"""Shared helpers for the local worker services.

The 8 GB-VRAM rule allows only one GPU job at a time across the API job queue,
the ASR worker and the TTS worker. Worker processes coordinate through
`GpuSlot`, a file-backed cross-process lock that works on Linux, macOS and
Windows.
"""
