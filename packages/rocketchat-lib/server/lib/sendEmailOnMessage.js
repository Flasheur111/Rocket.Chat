import moment from 'moment';

RocketChat.callbacks.add('afterSaveMessage', function(message, room) {
	// skips this callback if the message was edited
	if (message.editedAt) {
		return message;
	}

	if (message.ts && Math.abs(moment(message.ts).diff()) > 60000) {
		return message;
	}

	if (RocketChat.settings.get('Message_EmailNotificationAfterEditingExpires') && RocketChat.settings.get('Message_AllowEditing') === true && RocketChat.settings.get('Message_AllowEditing_BlockEditInMinutes') > 0) {
		const details = {
			'rid': message.rid,
			'_id': message._id,
			'ts': message.ts
		};
		details.ts.setMinutes(details.ts.getMinutes() + RocketChat.settings.get('Message_AllowEditing_BlockEditInMinutes'));

		RocketChat.EmailSchedule.sendOrScheduleNotification(details);
	} else {
		RocketChat.sendEmailOnMessage(message, room);
	}

	return message;

}, RocketChat.callbacks.priority.LOW, 'sendEmailOnMessage');

RocketChat.sendEmailOnMessage = function(message, room) {
	let emailSubject;
	const usersToSendEmail = {};
	const directMessage = room.t === 'd';

	if (directMessage) {
		usersToSendEmail[message.rid.replace(message.u._id, '')] = 1;

		emailSubject = TAPi18n.__('Offline_DM_Email', {
			user: message.u.username
		});

	} else {
		if (message.mentions) {
			message.mentions.forEach(function(mention) {
				usersToSendEmail[mention._id] = 1;
			});
		}

		emailSubject = TAPi18n.__('Offline_Mention_Email', {
			user: message.u.username,
			room: room.name
		});
	}

	const getMessageLink = (room, sub) => {
		const roomPath = RocketChat.roomTypes.getRouteLink(room.t, sub);
		const path = Meteor.absoluteUrl(roomPath ? roomPath.replace(/^\//, '') : '');
		const style = [
			'color: #fff;',
			'padding: 9px 12px;',
			'border-radius: 4px;',
			'background-color: #04436a;',
			'text-decoration: none;'
		].join(' ');
		const message = TAPi18n.__('Offline_Link_Message');
		return `<p style="text-align:center;margin-bottom:8px;"><a style="${ style }" href="${ path }">${ message }</a>`;
	};

	const divisorMessage = '<hr style="margin: 20px auto; border: none; border-bottom: 1px solid #dddddd;">';
	let messageHTML = s.escapeHTML(message.msg);

	message = RocketChat.callbacks.run('renderMessage', message);
	if (message.tokens && message.tokens.length > 0) {
		message.tokens.forEach((token) => {
			token.text = token.text.replace(/([^\$])(\$[^\$])/gm, '$1$$$2');
			messageHTML = messageHTML.replace(token.token, token.text);
		});
	}

	const header = RocketChat.placeholders.replace(RocketChat.settings.get('Email_Header') || '');
	const footer = RocketChat.placeholders.replace(RocketChat.settings.get('Email_Footer') || '');
	messageHTML = messageHTML.replace(/\n/gm, '<br/>');

	RocketChat.models.Subscriptions.findWithSendEmailByRoomId(room._id).forEach((sub) => {
		if (sub.disableNotifications) {
			delete usersToSendEmail[sub.u._id];
		} else {
			switch (sub.emailNotifications) {
				case 'all':
					usersToSendEmail[sub.u._id] = 'force';
					break;
				case 'mentions':
					if (usersToSendEmail[sub.u._id]) {
						usersToSendEmail[sub.u._id] = 'force';
					}
					break;
				case 'nothing':
					delete usersToSendEmail[sub.u._id];
					break;
				case 'default':
					break;
			}
		}
	});

	const userIdsToSendEmail = Object.keys(usersToSendEmail);

	let defaultLink;

	const linkByUser = {};
	if (RocketChat.roomTypes.hasCustomLink(room.t)) {
		RocketChat.models.Subscriptions.findByRoomIdAndUserIds(room._id, userIdsToSendEmail).forEach((sub) => {
			linkByUser[sub.u._id] = getMessageLink(room, sub);
		});
	} else {
		defaultLink = getMessageLink(room, { name: room.name });
	}

	if (userIdsToSendEmail.length > 0) {
		const usersOfMention = RocketChat.models.Users.getUsersToSendOfflineEmail(userIdsToSendEmail).fetch();

		if (usersOfMention && usersOfMention.length > 0) {
			const siteName = RocketChat.settings.get('Site_Name');

			usersOfMention.forEach((user) => {
				if (user.settings && user.settings.preferences && user.settings.preferences.emailNotificationMode && user.settings.preferences.emailNotificationMode === 'disabled' && usersToSendEmail[user._id] !== 'force') {
					return;
				}

				// Checks if user is in the room he/she is mentioned (unless it's public channel)
				if (room.t !== 'c' && room.usernames.indexOf(user.username) === -1) {
					return;
				}

				// Check if message still unread
				if (RocketChat.models.Subscriptions.findUnreadByRoomIdAndUserId(message.rid, user._id) === 0) {
					return;
				}

				user.emails.some((email) => {
					if (email.verified) {
						email = {
							to: email.address,
							from: RocketChat.settings.get('From_Email'),
							subject: `[${ siteName }] ${ emailSubject }`,
							html: header + messageHTML + divisorMessage + (linkByUser[user._id] || defaultLink) + footer
						};

						if (user.settings && user.settings.preferences && user.settings.preferences.offlineNotificationFrequency && user.settings.preferences.offlineNotificationFrequency > 0) {
							email.ts = RocketChat.EmailSchedule.getDigestTiming(user.settings.preferences.offlineNotificationFrequency);
							RocketChat.EmailSchedule.sendOrScheduleDigest(email);
						} else {
							Meteor.defer(() => {
								Email.send(email);
							});
						}

						return true;
					}
				});
			});
		}
	}
};