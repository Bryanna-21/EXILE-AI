
import { useState } from 'react';
import { Bot, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Message {
  id: string;
  content: string;
  sender: 'user' | 'ai';
  timestamp: Date;
}

const ChatSection = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      content: 'Hello! I\'m your AI Phone Assistant. I can help you with anything on your phone, whether you\'re online or offline. What would you like to do today?',
      sender: 'ai',
      timestamp: new Date(),
    },
  ]);

  const quickActions = [
    'Check my files',
    'Take a photo',
    'Analyze an image',
    'Share content',
    'Voice command',
    'Find apps',
  ];

  return (
    <div className="h-96">
      <div className="p-4 border-b bg-gradient-to-r from-purple-50 to-indigo-50">
        <h2 className="text-xl font-semibold text-gray-800 flex items-center gap-2">
          <Bot className="w-5 h-5 text-purple-600" />
          AI Assistant
        </h2>
        <p className="text-sm text-gray-600 mt-1">Your intelligent phone companion</p>
      </div>

      <ScrollArea className="h-64 p-4">
        <div className="space-y-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex gap-3 ${
                message.sender === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              {message.sender === 'ai' && (
                <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-4 h-4 text-purple-600" />
                </div>
              )}
              <div
                className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                  message.sender === 'user'
                    ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white'
                    : 'bg-gray-100 text-gray-800'
                }`}
              >
                <p className="text-sm">{message.content}</p>
                <p className="text-xs opacity-70 mt-1">
                  {message.timestamp.toLocaleTimeString()}
                </p>
              </div>
              {message.sender === 'user' && (
                <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                  <User className="w-4 h-4 text-indigo-600" />
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="p-4 border-t bg-gray-50">
        <div className="grid grid-cols-2 gap-2">
          {quickActions.map((action, index) => (
            <Button
              key={index}
              variant="outline"
              size="sm"
              className="text-xs hover:bg-purple-50 hover:border-purple-200"
              onClick={() => {
                const newMessage: Message = {
                  id: Date.now().toString(),
                  content: action,
                  sender: 'user',
                  timestamp: new Date(),
                };
                setMessages([...messages, newMessage]);
              }}
            >
              {action}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ChatSection;
