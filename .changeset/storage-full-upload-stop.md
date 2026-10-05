---
"@tinycloud/listen-cli": patch
---

Stop `listen upload` at the first write TinyCloud rejects because storage is full. The rest of the batch is not attempted, unsaved recordings stay pending for the next run instead of being marked failed, and the CLI prints the storage-full notice with the number of recordings left and exits with status 1.
