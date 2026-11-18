// Register / sign in / sign out / session check for the home page.
// New accounts must go through How to Play (see howto.js) before they can enter the lobby;
// the server remembers that (seenGuide) and refuses the lobby connection until it is done.
const GameRoom = (function() {
    // Username: letters, numbers, underscores (no spaces), 1-16 characters. Name: anything, 1-20 characters.
    const MIN_USERNAME = 1;
    const MAX_USERNAME = 16;
    const MAX_NAME = 20;

    // This stores the signed in user
    let user = null;
    // Other scripts hook in here: the lobby connects on sign in and disconnects on sign out
    const hooks = { onSignIn: null, onSignOut: null };

    // Show a message under a form; errors are red, success messages are green
    const showMessage = function(selector, text, isError) {
        $(selector).text(text).toggleClass("error", !!text && isError).toggleClass("success", !!text && !isError);
    };

    // Returns an error message, or "" when the registration input is fine
    const validateRegister = function(username, name, password, confirmPassword) {
        if (!username || !name || !password || !confirmPassword)
            return "Please fill in every field.";
        if (!/^\w+$/.test(username))
            return "Username can only contain letters, numbers and underscores (no spaces).";
        if (username.length < MIN_USERNAME || username.length > MAX_USERNAME)
            return `Username must be ${MIN_USERNAME}-${MAX_USERNAME} characters.`;
        if ([...name].length > MAX_NAME)
            return `Name can be at most ${MAX_NAME} characters.`;
        if (password != confirmPassword)
            return "Passwords do not match.";
        return "";
    };

    // Disable a form's buttons while its request is running (stops double submits)
    const setBusy = function(formSelector, busy) {
        $(formSelector).find("button").prop("disabled", busy);
    };

    // Go back to the start page (signed out)
    const showStartPage = function() {
        user = null;
        $("#game-room-content-page").hide();
        $("#game-room-signin-page").hide();
        $("#game-room-register-page").hide();
        $("#game-room-start-page").show();
    };

    // The player reached the end of How to Play: tell the server, then enter the lobby
    const finishGuide = function() {
        fetch("/guide-complete", { method: "POST" })
            .then((res) => res.json())
            .then((json) => {
                console.log("Endpoint '/guide-complete' -", json); // FOR MARKING - DON'T DELETE
                if (json.error) { showStartPage(); return; }
                if (hooks.onSignIn) hooks.onSignIn(user);
            })
            .catch(() => HowTo.open(finishGuide, true));     // network problem: show the guide again
    };

    // Show the sign-in page (used after a new player has read How to Play), username filled in
    const goToSignIn = function(username) {
        $("#game-room-register-page").hide();
        $("#game-room-signin-page").show();
        $("#signin-form").get(0).reset();
        $("#signin-username").val(username);
        showMessage("#signin-message", "Your account has been created. Sign in to play!", false);
        $("#signin-password").focus();
    };

    // A new player reached the end of the guide: tell the server, then send them to sign in
    const finishRegistrationGuide = function(username) {
        fetch("/guide-complete", { method: "POST" })
            .then((res) => res.json())
            .then((json) => {
                console.log("Endpoint '/guide-complete' -", json); // FOR MARKING - DON'T DELETE
                goToSignIn(username);      // if the server said no, signing in will show the guide again
            })
            .catch(() => HowTo.open(() => finishRegistrationGuide(username), true));
    };

    // Show the signed-in area. New players get the (required) guide first.
    const enter = function(json) {
        user = json.user;
        $("#game-room-user-name").text(user.name);
        $("#game-room-start-page, #game-room-signin-page, #game-room-register-page").hide();
        $("#game-room-content-page").show();
        if (json.needsGuide) {
            $("#howto-required-note").text(`Welcome, ${user.name}! Please go through all the steps before you play.`);
            HowTo.open(finishGuide, true);
        } else if (hooks.onSignIn) {
            hooks.onSignIn(user);
        }
    };

    const init = function() {
        $("#start-signin-button").on("click", function() {
            $("#game-room-start-page").hide();
            $("#game-room-signin-page").show();
            $("#signin-form").get(0).reset();
            showMessage("#signin-message", "", false);
            $("#signin-username").focus();
        });

        $("#start-register-button").on("click", function() {
            $("#game-room-start-page").hide();
            $("#game-room-register-page").show();
            $("#register-form").get(0).reset();
            showMessage("#register-message", "", false);
            $("#register-username").focus();
        });

        $(".back-button").on("click", function() {
            $("#game-room-start-page").show();
            $("#game-room-signin-page").hide();
            $("#game-room-register-page").hide();
        });

        // Show / Hide on password fields
        $(".toggle-password").on("click", function() {
            const $input = $(this).siblings("input");
            const show = $input.attr("type") === "password";
            $input.attr("type", show ? "text" : "password");
            $(this).text(show ? "Hide" : "Show").attr("aria-label", show ? "Hide password" : "Show password");
        });

        // Register (pressing Enter in any field submits too)
        $("#register-form").on("submit", function(e) {
            e.preventDefault();

            const username = $("#register-username").val().trim();
            const name     = $("#register-name").val().trim();
            const password = $("#register-password").val();
            const confirmPassword = $("#register-confirm").val();

            // Client-side validation (the server checks everything again)
            const problem = validateRegister(username, name, password, confirmPassword);
            if (problem) {
                showMessage("#register-message", problem, true);
                return;
            }

            setBusy("#register-form", true);
            fetch("/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, name, password })
            })
                .then((res) => res.json())
                .then((json) => {
                    console.log("Endpoint '/register' -", json); // FOR MARKING - DON'T DELETE

                    if (json.error) {
                        showMessage("#register-message", json.error, true);
                        return;
                    }

                    // Account created (not signed in yet): the new player must go through How to Play,
                    // then they sign in
                    $("#register-form").get(0).reset();
                    showMessage("#register-message", "", false);
                    $("#howto-required-note").text(`Welcome, ${json.name}! Please go through all the steps, then sign in.`);
                    HowTo.open(() => finishRegistrationGuide(json.username), true);
                })
                .catch(() => showMessage("#register-message", "Could not reach the server.", true))
                .finally(() => setBusy("#register-form", false));
        });

        // Sign in (pressing Enter in any field submits too)
        $("#signin-form").on("submit", function(e) {
            e.preventDefault();

            const username = $("#signin-username").val().trim();
            const password = $("#signin-password").val();

            if (!username || !password) {
                showMessage("#signin-message", "Please enter your username and password.", true);
                return;
            }

            setBusy("#signin-form", true);
            fetch("/signin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password })
            })
                .then((res) => res.json())
                .then((json) => {
                    console.log("Endpoint '/signin' -", json); // FOR MARKING - DON'T DELETE

                    if (json.error) {
                        showMessage("#signin-message", json.error, true);
                        $("#signin-password").val("").focus();
                        return;
                    }

                    $("#signin-form").get(0).reset();
                    enter(json);
                })
                .catch(() => showMessage("#signin-message", "Could not reach the server.", true))
                .finally(() => setBusy("#signin-form", false));
        });

        // Sign out
        $("#signout-form").on("submit", function(e) {
            e.preventDefault();

            fetch("/signout")
                .then((res) => res.json())
                .then((json) => {
                    console.log("Endpoint '/signout' -", json); // FOR MARKING - DON'T DELETE

                    if (json.error) {
                        console.log(json.error);
                        return;
                    }

                    showStartPage();
                    if (hooks.onSignOut) hooks.onSignOut();
                })
                .catch((err) => console.log(err));
        });
    };

    // Is this browser still signed in? (called when the page loads)
    const validate = function() {
        fetch("/validate")
            .then((res) => res.json())
            .then((json) => {
                console.log("Endpoint '/validate' -", json); // FOR MARKING - DON'T DELETE

                if (json.error) {
                    console.log(json.error);
                    return;
                }
                enter(json);
            })
            .catch((err) => console.log(err));
    };

    return { init, validate, hooks };
})();
