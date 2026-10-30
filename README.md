# Manglet Rehost
###### Manglet Rehost is made by Aaron by using old Manglet source code and remaking the sites and some parts of the backend.

### Want to self host?
###### To self host you need to configure your environment variables (example exists). Then to run it you do npm install and node server.js

### Do I need a database URL?
###### No, you do not need a database URL. It is used for the people who want to host it on stuff like Render or Railway where the files refresh on every commit.

### How do I edit the owner usernames?
###### To edit the owner usernames you find the line that starts with "const OWNER_USERNAMES" (line 207 as im writing this). You will need the OWNER_SETUP_CODE in .env when registering.

### How do I register an owner account?
###### Go to register site, type in the owner username that you have then type in the password. After that you will need to press right shift. This will show an owner code drop down. Click on the arrow and type in the code in your environment (OWNER_SETUP_CODE). Then register with the register button.

### What is the name for the database URL in the environments?
###### DATABASE_URL

### Where can I play this?
###### https://mangletrehost.aaronsstuff.com