ROVER TRACKER — home screen icon setup
========================================

1. Add these files to your Rover Tracker repo's /public folder (or wherever
   index.html and other static files live) on GitHub:
   - apple-touch-icon.png
   - icon-192.png
   - icon-512.png
   - manifest.json

2. In index.html, inside <head>, add these lines (same pattern as Med Tracker):

   <link rel="manifest" href="manifest.json">
   <link rel="apple-touch-icon" href="apple-touch-icon.png">
   <meta name="apple-mobile-web-app-capable" content="yes">
   <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
   <meta name="apple-mobile-web-app-title" content="Rover">
   <meta name="theme-color" content="#c9812f">

3. git pull on the server, rebuild/restart the rover-tracker container.

4. On your iPhone: remove the old Rover home screen icon if you already added
   one (long-press -> Remove App), then re-add via Safari Share -> Add to
   Home Screen so it picks up the new icon.
