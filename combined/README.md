# recline-backend

---

this is the very cool repo for the inner workings of the chat on my website intended for school.
this version is intended to not run on vercel, run 24/7

## The concept

This is a port to connect discord and web chats, sending via webhook, and reading via bot

### Authentication

- [x] Code is generated on server, displayed to user on frontend (/genCode endpoint)
- [x] User on frontend must send the request via school mail in order to authenticate
- [x] Server detects this on request to the /check endpoint
- [x] If ok, we let them in
- [x] When revisiting, checks validity of code on server and redirects accordingly (/checkSession endpoint)
- [x] Subsequent requests will also include the code/token in the request, stored in local storage

### Messaging

Due to vercel complications, we now have to do something different
Client -> api
Api -> Client via websocket
Api -> bot via webhook
Bot -> Api via endpoint
chat/realtime functions using ~~ably~~ websockets

- [x] USE 1 webhook, as we can change the username in the request and recieve it from the bot.
- [x] Send message via webhook on api server
- [ ] Fetch message via bot on bot server -> api server thru post request
- [ ] Message creation on client on api server -> bot server
- [ ] ~~Communication to bot via separate channel~~
- [x] Note in bot server: try not to store too many large variables.

Messages are sent to the server via the /sendMessage endpoint
The server will check the token in the request, and if it is valid, it will send the message to the webhook
We can have chats through

- Discrd (more secure reliable permenent solution) <-
- Mail (easier implementation but can be compromised)

#### Looking for size of message id

There are total of 128,390 messages sent so far in discord server
bytes in 1373775323824656394 (looking at size of length) -> 19 bytes
mult. by 100k check size -> 19 \* 100,000
= 1,900,000 bytes
= 1,900 kb
= 1.9 mb
so it should be fine to find a (db or const var, will take up memory tho)
Free plan in mongodb shold be fine
All we will be storing is an array with message ids from discord. Will store sent messages from client via webhook.

#### The bot

Will need to:

- create webhooks for each user
- and need to make sure no repeat by storing user and corresponding ids.
- new users outside of 802 such as teachers that need direct communication will need manual whitelisting i think
- Send message via webhook
- Read messages from discord, includes webhook and normal people; it's a bridge

#### The client

Will need to:

- Utilize notifications to make effective as chatting system
