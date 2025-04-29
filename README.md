# recline-backend

---

this is the very cool repo for the inner workings of the chat on my website intended for school.

## The concept

This is a port to connect discord and web chats, sending via webhook, and reading via bot

### Authentication

- [x] Code is generated on server, displayed to user on frontend (/genCode endpoint)
- [x] User on frontend must send the request via school mail in order to authenticate
- [x] Server detects this on request to the /check endpoint
- [x] If ok, we let them in
- [x] Subsequent requests will also include the code/token in the request, stored in local storage

### Messaging

Messages are sent to the server via the /sendMessage endpoint
The server will check the token in the request, and if it is valid, it will send the message to the webhook
