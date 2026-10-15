# Memory

Save useful facts and instructions for later conversations, and share them between your devices. Manage memory in **Settings → Memory** on web, desktop, or mobile, choosing the device whose memory you want to manage.

## Turn on memory

Memory starts off. To use it on one device, open **Settings → Memory** and choose **Make this device the hub**. You can add other devices later; there is one hub, and every device that shares memory can save and edit memories equally.

## Save and find memories

Choose **Remember something**, enter what you want to keep, and save it. Memories saved here are available across conversations on devices sharing memory. To keep a memory specific to a project or conversation, ask an agent with memory write access to save it for that project or conversation.

Search for a memory, open it to read its history, or use **Edit** to change it. Editing keeps it where it was saved.

Settings search may fail while search data is getting ready; clear the search to browse saved memories instead.

## Share between devices

To share memory, start from the hub. Connect your other device through [Connections](./remote-access.md), then use **Add device** in the hub’s Memory settings. You need settings write permission on both devices and a **Hub address** the other device can reach. Use HTTPS and avoid localhost, which points to the receiving device itself; saving the address does not verify connectivity.

Every member can save and edit memories when it has memory write permission. If you reach the device limit, remove a device before adding another. Use **Remove** to end a device’s shared-memory access, or **Replace key** to replace its sharing credential. Replacing a key requires a connection to that device and settings write permission there.

To stop sharing on a device, turn sharing off in its Memory settings (**Leave sharing** for a member on web or desktop). Saved memories stay, but you cannot save new memories while memory is off. To turn it back on, make the same device the hub again, or add the member from the hub’s Memory settings.

If device setup does not finish, use **Retry** to continue the same request. After a reload, use **Replace key** to recover the device or **Remove** to clean up incomplete setup. If settings changed on another device, review the latest settings before trying again.

## Read original conversations

A memory can point back to the conversation it came from. Under **Original conversations** in the Memory settings of the device that owns that conversation, allow the device that needs access. Use **Read original** from the memory’s history to read the source.

Removing that permission applies to later requests and to results still on the hub; it cannot recall content already delivered. Allowing the same device again may wait for its previous removal to complete. If the original is unavailable, check access or reconnect the source environment.

## Review conflicts

When devices make conflicting changes, only the conflicting memory is put on hold. GOAT automatically resolves it using the resolving device’s default provider and model, and applies the result without waiting for approval. If resolution fails, that memory stays on hold.

Open the memory’s history to review the resolution and judgment. The conflicting originals and judgment are kept for 30 days unless the memory is forgotten. During that window, choose a retained original and use **Revert resolution** to restore it once. Reverting requires the resolved memory to be unchanged and its original still available; a revert cannot itself be reverted. Deletion takes priority over edits, so an older edit cannot bring back a forgotten memory.

## Forget a memory

Open the memory, choose **Forget**, and confirm. This cannot be undone. Forgetting removes the GOAT memory’s content, retained resolution originals and judgment, and derived content such as summaries made from it. Other devices remove it when they sync.

The provider’s original conversation stays, but forgotten content is never imported again. Forgetting content does not automatically shrink the database file.

## Agent access

Agent memory access depends on the environment’s current policy and the run’s permissions. Scheduled tasks and delegated work also have a saved memory limit: `none`, `read`, or `read_write`. A displayed **Memory: read** or **Memory: read_write** is that saved limit, not proof of the access currently applied to a run. Turning agent memory access on at the environment cannot widen a task’s saved limit.

When connecting an outside agent through OAuth, select **Read memory** or **Write memory** under **Memory access (optional)** if needed. Nothing is selected by default, and memory permissions are separate from thread access.

## When a conversation cannot save memories

Forked or imported conversations, and conversations that have received more memories than GOAT can safely track, can still use memories but cannot save new ones or produce new memory summaries. Start a new conversation to save the memory.

## Connection problems

If an agent says its memory search was incomplete or unavailable, do not assume the memory is missing.

On web and desktop, if Memory says **Device disconnected**, reconnect that environment to continue. If it says **Memory unavailable**, update or reconnect the selected environment. **Hub disconnected** means the hub connection is offline; **Hub connected** alone does not mean every memory is ready to read. **Waiting to sync** means that memory still has changes to share.
